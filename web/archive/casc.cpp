// Offline browser bridge to CascLib. Game files are mounted read-only by the worker.
#include "CascLib.h"
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <emscripten.h>

static HANDLE storage = nullptr;
static unsigned char *result = nullptr;
static uint32_t result_size = 0;
static uint32_t last_error = 0;
static constexpr uint64_t max_resource_size = 128ULL * 1024 * 1024;

EM_JS(void, progress, (int stage, unsigned current, unsigned total), {
    Module.onProgress?.({stage, current, total});
});

static bool WINAPI on_progress(void *, CASC_PROGRESS_MSG stage, const char *, DWORD current, DWORD total) {
    progress(static_cast<int>(stage), current, total);
    return false;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE void pf_close() {
    if (storage) CascCloseStorage(storage);
    storage = nullptr;
    free(result);
    result = nullptr;
    result_size = 0;
}

EMSCRIPTEN_KEEPALIVE int pf_open(const char *path, const char *product) {
    pf_close();
    CASC_OPEN_STORAGE_ARGS args{};
    args.Size = sizeof(args);
    args.szLocalPath = path;
    args.szCodeName = product;
    args.dwLocaleMask = CASC_LOCALE_ENUS;
    args.PfnProgressCallback = on_progress;
    // Offline only. No CASC_FEATURE_ALLOW_DOWNLOAD, online storage or zero-fill recovery.
    bool ok = CascOpenStorageEx(nullptr, &args, false, &storage);
    last_error = ok ? 0 : GetCascError();
    return ok;
}

static uintptr_t read_file(const char *name, uint32_t file_id, uint32_t offset, uint32_t length, bool range) {
    free(result);
    result = nullptr;
    result_size = 0;
    last_error = 0;
    if (!storage) { last_error = ERROR_INVALID_HANDLE; return 0; }
    HANDLE file = nullptr;
    DWORD flags = CASC_STRICT_DATA_CHECK | (file_id ? CASC_OPEN_BY_FILEID : CASC_OPEN_BY_NAME);
    const char *key = file_id ? reinterpret_cast<const char *>(static_cast<uintptr_t>(file_id)) : name;
    if (!CascOpenFile(storage, key, CASC_LOCALE_ENUS, flags, &file)) {
        last_error = GetCascError();
        return 0;
    }
    ULONGLONG size = 0;
    if (!CascGetFileSize64(file, &size) || size > max_resource_size) {
        last_error = ERROR_FILE_CORRUPT;
        CascCloseFile(file);
        return 0;
    }
    if (range) {
        if (offset > size || length > size - offset ||
            !CascSetFilePointer64(file, offset, nullptr, FILE_BEGIN)) {
            last_error = ERROR_FILE_CORRUPT;
            CascCloseFile(file);
            return 0;
        }
        size = length;
    }
    result = static_cast<unsigned char *>(malloc(size ? static_cast<size_t>(size) : 1));
    DWORD read = 0;
    if (!result || !CascReadFile(file, result, static_cast<DWORD>(size), &read) || read != size) {
        last_error = result ? GetCascError() : ERROR_NOT_ENOUGH_MEMORY;
        if (!last_error) last_error = ERROR_FILE_CORRUPT;
        free(result);
        result = nullptr;
    } else {
        result_size = read;
    }
    CascCloseFile(file);
    return reinterpret_cast<uintptr_t>(result);
}

EMSCRIPTEN_KEEPALIVE uintptr_t pf_read(const char *name, uint32_t file_id) {
    return read_file(name, file_id, 0, 0, false);
}

EMSCRIPTEN_KEEPALIVE uintptr_t pf_read_range(const char *name, uint32_t file_id, uint32_t offset, uint32_t length) {
    return read_file(name, file_id, offset, length, true);
}

EMSCRIPTEN_KEEPALIVE uint32_t pf_size() { return result_size; }
EMSCRIPTEN_KEEPALIVE uint32_t pf_error() { return last_error; }
// CascPort maps this constant to the target's errno, which differs between
// native platforms and Emscripten. Keep that classification beside CascLib.
EMSCRIPTEN_KEEPALIVE int pf_error_is_missing() { return last_error == ERROR_FILE_NOT_FOUND; }
EMSCRIPTEN_KEEPALIVE int pf_error_is_encrypted() { return last_error == ERROR_FILE_ENCRYPTED; }
}
