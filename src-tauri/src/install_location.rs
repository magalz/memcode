//! Detect an app launched from its installer before offering in-place updates.
//! Moving the app is deliberately left to Finder's normal installation flow.

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationStatus {
    pub state: &'static str,
    pub needs_install: bool,
    pub can_update: bool,
}

fn result(state: &'static str, needs_install: bool, can_update: bool) -> InstallationStatus {
    InstallationStatus {
        state,
        needs_install,
        can_update,
    }
}

fn app_bundle(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

fn classify(
    macos: bool,
    executable: &Path,
    home: Option<&Path>,
    volume_read_only: Option<bool>,
) -> InstallationStatus {
    if !macos {
        return result("not-applicable", false, true);
    }
    let Some(bundle) = app_bundle(executable) else {
        return result("development", false, false);
    };
    // Gatekeeper can launch downloaded apps from a randomized, read-only
    // AppTranslocation location. Match a path component, not a substring.
    if bundle
        .components()
        .any(|part| part.as_os_str() == "AppTranslocation")
    {
        return result("translocated", true, false);
    }
    if volume_read_only == Some(true) {
        let state = if bundle.starts_with("/Volumes") {
            "disk-image"
        } else {
            "read-only"
        };
        return result(state, true, false);
    }
    if bundle.starts_with("/Applications")
        || home.is_some_and(|home| bundle.starts_with(home.join("Applications")))
    {
        return result("installed", false, true);
    }
    // A writable external volume is a supported portable install, not a DMG.
    // If the native resource property is unavailable, do not guess otherwise.
    result("portable", false, true)
}

#[cfg(target_os = "macos")]
fn volume_is_read_only(bundle: &Path) -> Option<bool> {
    use core_foundation::{
        base::{CFType, CFTypeRef, TCFType},
        boolean::CFBoolean,
        error::CFErrorRef,
        string::CFStringRef,
        url::{kCFURLVolumeIsReadOnlyKey, CFURLRef, CFURL},
    };
    // core-foundation-sys 0.8 does not yet bind this public Core Foundation API.
    // The Copy rule retains the returned resource value and optional CFError.
    unsafe extern "C" {
        fn CFURLCopyResourcePropertyForKey(
            url: CFURLRef,
            key: CFStringRef,
            value: *mut CFTypeRef,
            error: *mut CFErrorRef,
        ) -> u8;
    }
    let url = CFURL::from_path(bundle, true)?;
    let mut value = std::ptr::null();
    let mut error: CFErrorRef = std::ptr::null_mut();
    unsafe {
        let success = CFURLCopyResourcePropertyForKey(
            url.as_concrete_TypeRef(),
            kCFURLVolumeIsReadOnlyKey,
            &mut value,
            &mut error,
        );
        if !error.is_null() {
            drop(CFType::wrap_under_create_rule(error.cast()));
        }
        if value.is_null() {
            return None;
        }
        let value = CFType::wrap_under_create_rule(value);
        (success != 0)
            .then(|| value.downcast::<CFBoolean>().map(bool::from))
            .flatten()
    }
}

pub fn status() -> InstallationStatus {
    #[cfg(target_os = "macos")]
    {
        let Ok(executable) = std::env::current_exe() else {
            return result("development", false, false);
        };
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let read_only = app_bundle(&executable).and_then(|bundle| volume_is_read_only(&bundle));
        classify(true, &executable, home.as_deref(), read_only)
    }
    #[cfg(not(target_os = "macos"))]
    {
        result("not-applicable", false, true)
    }
}

/// The caller must already have restricted access to the trusted main webview.
/// No path or shell command is accepted from browser/artifact content.
pub fn show_install_location() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let bundle = app_bundle(&executable).ok_or("MemCode is not running from an app bundle.")?;
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(bundle)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("This installation action is available only on macOS.".into())
    }
}

/// Open the standard installation destination; Finder performs the actual move.
pub fn show_applications() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("/Applications")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("This installation action is available only on macOS.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_installs_are_not_blocked() {
        for app in [
            "/Applications/MemCode.app/Contents/MacOS/memcode",
            "/Users/test/Applications/MemCode.app/Contents/MacOS/memcode",
        ] {
            for read_only in [Some(false), None] {
                assert_eq!(
                    classify(
                        true,
                        Path::new(app),
                        Some(Path::new("/Users/test")),
                        read_only
                    ),
                    result("installed", false, true)
                );
            }
        }
    }

    #[test]
    fn mounted_installer_cannot_update_in_place() {
        assert_eq!(
            classify(
                true,
                Path::new("/Volumes/MemCode/MemCode.app/Contents/MacOS/memcode"),
                None,
                Some(true)
            ),
            result("disk-image", true, false)
        );
    }

    #[test]
    fn writable_external_installs_are_supported() {
        assert_eq!(
            classify(
                true,
                Path::new("/Volumes/DeveloperApps/MemCode.app/Contents/MacOS/memcode"),
                None,
                Some(false)
            ),
            result("portable", false, true)
        );
    }

    #[test]
    fn translocation_is_matched_as_a_component() {
        assert_eq!(
            classify(true, Path::new("/private/var/folders/session/AppTranslocation/uuid/d/MemCode.app/Contents/MacOS/memcode"), None, None),
            result("translocated", true, false)
        );
        assert_eq!(
            classify(
                true,
                Path::new("/Users/test/AppTranslocationNotes/MemCode.app/Contents/MacOS/memcode"),
                None,
                Some(false)
            ),
            result("portable", false, true)
        );
    }

    #[test]
    fn read_only_paths_and_unknown_volumes_are_not_confused() {
        let executable = Path::new("/Users/test/ReadOnly/MemCode.app/Contents/MacOS/memcode");
        assert_eq!(
            classify(true, executable, None, Some(true)),
            result("read-only", true, false)
        );
        assert_eq!(
            classify(true, executable, None, None),
            result("portable", false, true)
        );
    }

    #[test]
    fn source_runs_and_other_platforms_are_safe() {
        let executable = Path::new("/workspace/target/debug/memcode");
        assert_eq!(
            classify(true, executable, None, None),
            result("development", false, false)
        );
        assert_eq!(
            classify(false, executable, None, None),
            result("not-applicable", false, true)
        );
        assert!(app_bundle(Path::new(
            "/tmp/MemCode.app/unrelated/Contents/MacOS/memcode"
        ))
        .is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_volume_resource_property_is_readable() {
        assert_eq!(volume_is_read_only(&std::env::temp_dir()), Some(false));
    }
}
