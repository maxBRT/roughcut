//! The Windows parts: the user's Videos folder and Windows Credential Manager.

use std::path::PathBuf;

use rc_types::AppError;

/// The Credential Manager entry ("generic credential") that holds the Anthropic API key.
pub const DEFAULT_API_KEY_TARGET: &str = "Roughcut/anthropic-api-key";

/// Credential Manager limits a credential blob to 5 * 512 bytes.
const MAX_KEY_BYTES: usize = 5 * 512;

/// The user's Videos folder (the known folder, so a folder moved to another drive or to
/// OneDrive is found), or `%USERPROFILE%\Videos` when it cannot be asked for.
pub fn videos_folder() -> PathBuf {
    #[cfg(windows)]
    if let Some(p) = win::known_videos_folder() {
        return p;
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join("Videos"))
        .unwrap_or_else(|| PathBuf::from("Videos"))
}

/// The API key in Windows Credential Manager (spec 3.8), under one target name. Only used
/// when `claudeAuth` is `'api_key'`; the key never goes into the settings file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiKeyStore {
    target: String,
}

impl Default for ApiKeyStore {
    fn default() -> Self {
        ApiKeyStore::new(DEFAULT_API_KEY_TARGET)
    }
}

impl ApiKeyStore {
    /// A store for the credential named `target` (tests use their own name).
    pub fn new(target: impl Into<String>) -> ApiKeyStore {
        ApiKeyStore { target: target.into() }
    }

    /// The credential's target name.
    pub fn target(&self) -> &str {
        &self.target
    }

    /// Saves the key (replacing any earlier one). Surrounding spaces are dropped.
    pub fn set(&self, key: &str) -> Result<(), AppError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::internal("The API key is empty."));
        }
        if key.len() > MAX_KEY_BYTES {
            return Err(AppError::internal("The API key is too long."));
        }
        imp::write(&self.target, key.as_bytes())
    }

    /// The saved key, or `None` when there is none.
    pub fn get(&self) -> Result<Option<String>, AppError> {
        match imp::read(&self.target)? {
            None => Ok(None),
            Some(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| AppError::internal("The saved API key is not readable text.")),
        }
    }

    /// Removes the key. Removing a key that is not there is not an error.
    pub fn delete(&self) -> Result<(), AppError> {
        imp::delete(&self.target)
    }
}

#[cfg(windows)]
use win as imp;

#[cfg(windows)]
mod win {
    use std::path::PathBuf;
    use std::ptr;

    use rc_types::AppError;
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Videos, SHGetKnownFolderPath};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error(what: &str) -> AppError {
        AppError::internal(format!("Could not {what} in Windows Credential Manager.")).with_detail(std::io::Error::last_os_error().to_string())
    }

    pub fn known_videos_folder() -> Option<PathBuf> {
        let mut out: *mut u16 = ptr::null_mut();
        // SAFETY: valid GUID pointer and out pointer; the returned buffer is freed below
        // with CoTaskMemFree as the API requires, also when the call fails.
        let hr = unsafe { SHGetKnownFolderPath(&FOLDERID_Videos, 0, ptr::null_mut(), &mut out) };
        let result = if hr == 0 && !out.is_null() {
            // SAFETY: on success `out` is a NUL-terminated UTF-16 string.
            let len = (0..).take_while(|&i| unsafe { *out.add(i) } != 0).count();
            let slice = unsafe { std::slice::from_raw_parts(out, len) };
            use std::os::windows::ffi::OsStringExt;
            Some(PathBuf::from(std::ffi::OsString::from_wide(slice)))
        } else {
            None
        };
        // SAFETY: CoTaskMemFree accepts null.
        unsafe { CoTaskMemFree(out as *const _) };
        result.filter(|p| !p.as_os_str().is_empty())
    }

    pub fn write(target: &str, secret: &[u8]) -> Result<(), AppError> {
        let mut target_w = wide(target);
        let mut user_w = wide("Roughcut");
        let mut blob = secret.to_vec();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_mut_ptr(),
            Comment: ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: u32::try_from(blob.len()).map_err(|_| AppError::internal("secret too long"))?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: ptr::null_mut(),
            UserName: user_w.as_mut_ptr(),
        };
        // SAFETY: every pointer in `cred` points into a buffer that outlives the call.
        let ok = unsafe { CredWriteW(&cred, 0) };
        blob.iter_mut().for_each(|b| *b = 0);
        if ok == 0 { Err(last_error("save the API key")) } else { Ok(()) }
    }

    pub fn read(target: &str) -> Result<Option<Vec<u8>>, AppError> {
        let target_w = wide(target);
        let mut cred: *mut CREDENTIALW = ptr::null_mut();
        // SAFETY: valid NUL-terminated target and out pointer; freed with CredFree below.
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                return Ok(None);
            }
            return Err(AppError::internal("Could not read the API key from Windows Credential Manager.").with_detail(err.to_string()));
        }
        // SAFETY: on success `cred` points to a CREDENTIALW whose blob has
        // CredentialBlobSize bytes; we copy them before freeing.
        let bytes = unsafe {
            let c = &*cred;
            let v = if c.CredentialBlob.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
            };
            CredFree(cred as *const _);
            v
        };
        Ok(Some(bytes))
    }

    pub fn delete(target: &str) -> Result<(), AppError> {
        let target_w = wide(target);
        // SAFETY: valid NUL-terminated target.
        let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                return Ok(());
            }
            return Err(AppError::internal("Could not remove the API key from Windows Credential Manager.").with_detail(err.to_string()));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use rc_types::AppError;

    fn unsupported() -> AppError {
        AppError::internal("Windows Credential Manager is only available on Windows.")
    }
    pub fn write(_target: &str, _secret: &[u8]) -> Result<(), AppError> {
        Err(unsupported())
    }
    pub fn read(_target: &str) -> Result<Option<Vec<u8>>, AppError> {
        Err(unsupported())
    }
    pub fn delete(_target: &str) -> Result<(), AppError> {
        Err(unsupported())
    }
}
