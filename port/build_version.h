#ifndef PORT_BUILD_VERSION_H
#define PORT_BUILD_VERSION_H
/* Release version (VERSION file) lives in the CMake-generated build_version.cpp, not in a
 * compile definition, so a version bump does not recompile the port. The string sits in a
 * writable 64-byte slot (marker "@@BSVERSLOT@@|" + value) that scripts/package-windows.ps1
 * can patch in the staged exe. */
const char *battleship_version(void);
#define BATTLESHIP_CURRENT_VERSION battleship_version()
#endif
