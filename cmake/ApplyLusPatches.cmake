# Applies patches/libultraship/*.patch to the libultraship submodule.
# Idempotent: a patch already applied (git apply --check --reverse succeeds) is skipped.
find_package(Git REQUIRED)
set(_lus_dir "${CMAKE_CURRENT_SOURCE_DIR}/libultraship")
file(GLOB _lus_patches "${CMAKE_CURRENT_SOURCE_DIR}/patches/libultraship/*.patch")
list(SORT _lus_patches)
foreach(_p IN LISTS _lus_patches)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_p}")
    get_filename_component(_n "${_p}" NAME)
    execute_process(COMMAND "${GIT_EXECUTABLE}" apply --check --reverse "${_p}"
        WORKING_DIRECTORY "${_lus_dir}" RESULT_VARIABLE _rev OUTPUT_QUIET ERROR_QUIET)
    if(_rev EQUAL 0)
        message(STATUS "libultraship patch already applied: ${_n}")
        continue()
    endif()
    execute_process(COMMAND "${GIT_EXECUTABLE}" apply "${_p}"
        WORKING_DIRECTORY "${_lus_dir}" RESULT_VARIABLE _res ERROR_VARIABLE _err)
    if(NOT _res EQUAL 0)
        message(FATAL_ERROR "Failed to apply ${_n} to libultraship (is the submodule at the pinned commit?):\n${_err}")
    endif()
    message(STATUS "libultraship patch applied: ${_n}")
endforeach()
