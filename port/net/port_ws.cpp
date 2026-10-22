/* See port_ws.h. */
#include "port_ws.h"
#include "port_log.h"

#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#include <winhttp.h>

namespace {

struct Connection {
    HINTERNET session = nullptr;
    HINTERNET connect = nullptr;
    HINTERNET request = nullptr;
    HINTERNET socket = nullptr;
};

std::mutex sMutex;                       // guards the queues, error text and handles
std::atomic<int> sState{ PORT_WS_CLOSED };
std::string sError;
std::deque<std::string> sTextQueue;
std::deque<std::vector<unsigned char>> sBinaryQueue;
Connection sConn;
std::thread sThread;
std::atomic<bool> sStop{ false };

/* Relayed game packets are sent from a background thread: WinHTTP's send can
 * block when the server (or the network) is slow, and the game thread must
 * never wait on it. The queue is bounded; when it is full the oldest packet
 * is dropped, like a congested network would. */
constexpr size_t kSendQueueMax = 256;
std::deque<std::vector<unsigned char>> sSendQueue;
std::condition_variable sSendCv;
std::thread sSendThread;
unsigned int sSendDropped = 0;

void send_loop(void);

std::wstring widen(const std::string &s)
{
    if (s.empty()) {
        return std::wstring();
    }
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &w[0], n);
    return w;
}

void fail(const std::string &why)
{
    {
        std::lock_guard<std::mutex> lock(sMutex);
        sError = why;
    }
    sState = PORT_WS_FAILED;
    port_log("SSB64 WS: %s\n", why.c_str());
}

void close_handles(void)
{
    std::lock_guard<std::mutex> lock(sMutex);
    if (sConn.socket) { WinHttpCloseHandle(sConn.socket); sConn.socket = nullptr; }
    if (sConn.request) { WinHttpCloseHandle(sConn.request); sConn.request = nullptr; }
    if (sConn.connect) { WinHttpCloseHandle(sConn.connect); sConn.connect = nullptr; }
    if (sConn.session) { WinHttpCloseHandle(sConn.session); sConn.session = nullptr; }
}

void run(std::string url)
{
    bool secure = false;
    std::string rest;
    if (url.rfind("wss://", 0) == 0) {
        secure = true;
        rest = url.substr(6);
    } else if (url.rfind("ws://", 0) == 0) {
        rest = url.substr(5);
    } else {
        fail("server URL must start with ws:// or wss://");
        return;
    }
    size_t slash = rest.find('/');
    std::string hostport = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    std::string path = (slash == std::string::npos) ? "/" : rest.substr(slash);
    std::string host = hostport;
    INTERNET_PORT port = secure ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
    size_t colon = hostport.rfind(':');
    if (colon != std::string::npos) {
        host = hostport.substr(0, colon);
        port = static_cast<INTERNET_PORT>(std::stoi(hostport.substr(colon + 1)));
    }

    HINTERNET session = WinHttpOpen(L"BattleShip-Netplay/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) { fail("WinHttpOpen failed"); return; }
    WinHttpSetTimeouts(session, 5000, 5000, 5000, 0);   // receive: block forever (background thread)
    HINTERNET connect = WinHttpConnect(session, widen(host).c_str(), port, 0);
    HINTERNET request = connect ? WinHttpOpenRequest(connect, L"GET", widen(path).c_str(), nullptr,
                                                     WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                     secure ? WINHTTP_FLAG_SECURE : 0)
                                : nullptr;
    {
        std::lock_guard<std::mutex> lock(sMutex);
        sConn.session = session;
        sConn.connect = connect;
        sConn.request = request;
    }
    if (!connect || !request) { fail("couldn't reach " + host); close_handles(); return; }

    if (!WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) ||
        !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) ||
        !WinHttpReceiveResponse(request, nullptr)) {
        fail("couldn't connect to " + host + " (error " + std::to_string(GetLastError()) + ")");
        close_handles();
        return;
    }
    DWORD status = 0;
    DWORD size = sizeof(status);
    WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &status, &size, nullptr);
    if (status != 101) {
        fail("server answered HTTP " + std::to_string(status));
        close_handles();
        return;
    }
    HINTERNET socket = WinHttpWebSocketCompleteUpgrade(request, 0);
    if (!socket) { fail("WebSocket upgrade failed"); close_handles(); return; }
    {
        std::lock_guard<std::mutex> lock(sMutex);
        WinHttpCloseHandle(sConn.request);
        sConn.request = nullptr;
        sConn.socket = socket;
    }
    sState = PORT_WS_OPEN;
    sSendThread = std::thread(send_loop);

    std::vector<unsigned char> message;
    unsigned char buffer[4096];
    while (!sStop) {
        DWORD read = 0;
        WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
        DWORD err = WinHttpWebSocketReceive(socket, buffer, sizeof(buffer), &read, &type);
        if (err != ERROR_SUCCESS) {
            if (!sStop) fail("connection to the server was lost");
            break;
        }
        if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
            if (!sStop) {
                USHORT code = 0;
                char reason[128] = {};
                DWORD reason_len = 0;
                WinHttpWebSocketQueryCloseStatus(socket, &code, reason, sizeof(reason) - 1, &reason_len);
                fail(std::string("server closed the connection") + (reason_len ? std::string(": ") + reason : ""));
            }
            break;
        }
        message.insert(message.end(), buffer, buffer + read);
        bool fragment = (type == WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE ||
                         type == WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE);
        if (fragment) {
            continue;
        }
        std::lock_guard<std::mutex> lock(sMutex);
        if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
            sTextQueue.emplace_back(message.begin(), message.end());
        } else {
            sBinaryQueue.push_back(message);
        }
        message.clear();
    }
}

HINTERNET current_socket(void)
{
    std::lock_guard<std::mutex> lock(sMutex);
    return sConn.socket;
}

void send_loop(void)
{
    for (;;) {
        std::vector<unsigned char> packet;
        {
            std::unique_lock<std::mutex> lock(sMutex);
            sSendCv.wait(lock, [] { return sStop.load() || !sSendQueue.empty(); });
            if (sStop) {
                return;
            }
            packet = std::move(sSendQueue.front());
            sSendQueue.pop_front();
        }
        HINTERNET socket = current_socket();
        if (socket) {
            WinHttpWebSocketSend(socket, WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE, packet.data(),
                                 static_cast<DWORD>(packet.size()));
        }
    }
}

int send_frame(const void *data, DWORD size, WINHTTP_WEB_SOCKET_BUFFER_TYPE type)
{
    if (sState != PORT_WS_OPEN) {
        return 0;
    }
    HINTERNET socket;
    {
        std::lock_guard<std::mutex> lock(sMutex);
        socket = sConn.socket;
    }
    if (!socket) {
        return 0;
    }
    return WinHttpWebSocketSend(socket, type, const_cast<void *>(data), size) == ERROR_SUCCESS ? 1 : 0;
}

} // namespace

extern "C" int port_ws_connect(const char *url)
{
    port_ws_close();
    sStop = false;
    {
        std::lock_guard<std::mutex> lock(sMutex);
        sError.clear();
        sTextQueue.clear();
        sBinaryQueue.clear();
        sSendQueue.clear();
        sSendDropped = 0;
    }
    sState = PORT_WS_CONNECTING;
    sThread = std::thread(run, std::string(url ? url : ""));
    return 1;
}

extern "C" void port_ws_close(void)
{
    sStop = true;
    sSendCv.notify_all();
    {
        std::lock_guard<std::mutex> lock(sMutex);
        if (sConn.socket) {
            WinHttpWebSocketClose(sConn.socket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
        }
    }
    close_handles();    // unblocks a pending receive / send / connect
    if (sThread.joinable()) {
        sThread.join();
    }
    if (sSendThread.joinable()) {
        sSendThread.join();
    }
    sState = PORT_WS_CLOSED;
}

extern "C" int port_ws_state(void)
{
    return sState;
}

extern "C" const char *port_ws_error(void)
{
    static std::string copy;
    std::lock_guard<std::mutex> lock(sMutex);
    copy = sError;
    return copy.c_str();
}

extern "C" int port_ws_send_text(const char *text)
{
    return send_frame(text, static_cast<DWORD>(std::strlen(text)), WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE);
}

extern "C" int port_ws_send_binary(const void *data, int size)
{
    if (sState != PORT_WS_OPEN || data == nullptr || size <= 0) {
        return 0;
    }
    {
        std::lock_guard<std::mutex> lock(sMutex);
        if (sSendQueue.size() >= kSendQueueMax) {
            sSendQueue.pop_front();
            sSendDropped++;
        }
        const unsigned char *bytes = static_cast<const unsigned char *>(data);
        sSendQueue.emplace_back(bytes, bytes + size);
    }
    sSendCv.notify_one();
    return 1;
}

extern "C" int port_ws_poll_text(char *out, int capacity)
{
    std::lock_guard<std::mutex> lock(sMutex);
    if (sTextQueue.empty() || capacity <= 0) {
        return 0;
    }
    std::string text = std::move(sTextQueue.front());
    sTextQueue.pop_front();
    size_t n = (text.size() < static_cast<size_t>(capacity - 1)) ? text.size() : static_cast<size_t>(capacity - 1);
    std::memcpy(out, text.data(), n);
    out[n] = '\0';
    return 1;
}

extern "C" int port_ws_poll_binary(void *out, int capacity)
{
    std::lock_guard<std::mutex> lock(sMutex);
    if (sBinaryQueue.empty()) {
        return 0;
    }
    std::vector<unsigned char> data = std::move(sBinaryQueue.front());
    sBinaryQueue.pop_front();
    if (static_cast<int>(data.size()) > capacity) {
        return 0;   // oversized: drop
    }
    std::memcpy(out, data.data(), data.size());
    return static_cast<int>(data.size());
}

#else

extern "C" int port_ws_connect(const char *) { return 0; }
extern "C" void port_ws_close(void) {}
extern "C" int port_ws_state(void) { return PORT_WS_FAILED; }
extern "C" const char *port_ws_error(void) { return "online lobby is only implemented on Windows so far"; }
extern "C" int port_ws_send_text(const char *) { return 0; }
extern "C" int port_ws_send_binary(const void *, int) { return 0; }
extern "C" int port_ws_poll_text(char *, int) { return 0; }
extern "C" int port_ws_poll_binary(void *, int) { return 0; }

#endif
