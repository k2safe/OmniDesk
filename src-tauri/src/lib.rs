use aes_gcm::{
  aead::{Aead, KeyInit},
  Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose, Engine as _};
use image::GenericImageView;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
  collections::HashSet,
  fs,
  io::{Read, Write},
  net::{TcpListener, TcpStream, UdpSocket},
  path::PathBuf,
  process::Command,
  sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
  },
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const DB_FILE: &str = "omnidesk.sqlite3";
const MAIN_WINDOW_LABEL: &str = "main";
const QUICK_PANEL_LABEL: &str = "quick-panel";
const META_MASTER_KEY: &str = "master";
const META_SHORTCUTS_KEY: &str = "global_shortcuts";
const SENSITIVE_STORE_KEYS: &[&str] = &["vault", "totp", "fileVault"];
const VERIFIER_TEXT: &[u8] = b"omnidesk-master-verifier-v1";
const NOTE_ASSET_DIR: &str = "note-assets";
const NOTE_ASSET_PREFIX: &str = "omnidesk-asset://note-assets/";
const MAX_NOTE_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const VAULT_FILE_DIR: &str = "vault-files";
const MAX_VAULT_FILE_BYTES: usize = 100 * 1024 * 1024;
const COLOR_SAMPLE_DIR: &str = "color-samples";
const LOCAL_DROP_DIR: &str = "local-drop-inbox";
const EXPORT_DIR: &str = "OmniDesk Exports";
const MIGRATION_MANIFEST: &str = "omnidesk-migration.json";
const MIGRATION_RESOURCE_DIRS: &[&str] = &[
  NOTE_ASSET_DIR,
  VAULT_FILE_DIR,
  COLOR_SAMPLE_DIR,
  LOCAL_DROP_DIR,
];
const LOCAL_DROP_TTL: Duration = Duration::from_secs(10 * 60);
const LOCAL_DROP_MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

#[derive(Default)]
struct RuntimeState {
  key: Mutex<Option<[u8; 32]>>,
  cache: Mutex<Option<Map<String, Value>>>,
  local_drop: Mutex<Option<LocalDropServer>>,
  flush_generation: AtomicU64,
}

type AppState = Arc<RuntimeState>;

#[derive(Debug, Serialize, Deserialize)]
struct MasterRecord {
  version: u8,
  kdf: String,
  salt: String,
  nonce: String,
  verifier: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedPayload {
  version: u8,
  nonce: String,
  ciphertext: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedNoteImage {
  markdown_src: String,
  file_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedVaultFile {
  id: String,
  file_name: String,
  encrypted_file_name: String,
  size: u64,
  created_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
  exported: bool,
  file_name: String,
  path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChromeBookmarkImportResult {
  found: usize,
  imported: usize,
  skipped: usize,
  profiles: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedColor {
  hex: String,
  rgb: String,
  red: u8,
  green: u8,
  blue: u8,
  x: i32,
  y: i32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalDropInfo {
  url: String,
  inbox_path: String,
  token: String,
  port: u16,
  expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GlobalShortcutConfig {
  action: String,
  accelerator: String,
}

struct LocalDropServer {
  info: LocalDropInfo,
  stop: Arc<AtomicBool>,
}

fn show_main_window(app: AppHandle) -> Result<(), String> {
  let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
    return Err("主窗口不存在".to_string());
  };
  window.show().map_err(|err| format!("显示主窗口失败: {err}"))?;
  window
    .set_focus()
    .map_err(|err| format!("聚焦主窗口失败: {err}"))?;
  Ok(())
}

fn get_or_create_quick_panel(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
  if let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) {
    return Ok(window);
  }

  WebviewWindowBuilder::new(
    app,
    QUICK_PANEL_LABEL,
    WebviewUrl::App("index.html?quick=1".into()),
  )
  .title("OmniDesk Quick")
  .inner_size(640.0, 520.0)
  .min_inner_size(640.0, 520.0)
  .max_inner_size(640.0, 520.0)
  .resizable(false)
  .decorations(false)
  .transparent(true)
  .always_on_top(true)
  .visible_on_all_workspaces(true)
  .skip_taskbar(true)
  .shadow(true)
  .visible(false)
  .center()
  .build()
  .map_err(|err| format!("创建悬浮窗失败: {err}"))
}

fn open_quick_panel(app: &AppHandle) -> Result<(), String> {
  let window = get_or_create_quick_panel(app)?;
  window.center().map_err(|err| format!("居中悬浮窗失败: {err}"))?;
  window.show().map_err(|err| format!("显示悬浮窗失败: {err}"))?;
  window
    .set_focus()
    .map_err(|err| format!("聚焦悬浮窗失败: {err}"))?;
  Ok(())
}

fn emit_quick_status(app: &AppHandle, status: String) {
  let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) else {
    return;
  };
  if !window.is_visible().unwrap_or(false) {
    return;
  }

  let app = app.clone();
  thread::spawn(move || {
    for delay in [160_u64, 600] {
      thread::sleep(Duration::from_millis(delay));
      if let Err(err) = app.emit("omnidesk-quick-status", status.clone()) {
        log::warn!("Failed to emit quick panel status: {err}");
      }
    }
  });
}

fn emit_hotkey_status(app: &AppHandle, status: String) {
  if let Err(err) = app.emit("omnidesk-hotkey-status", status.clone()) {
    log::warn!("Failed to emit hotkey status: {err}");
  }
  emit_quick_status(app, status);
}

#[tauri::command]
fn toggle_quick_panel(app: AppHandle) -> Result<(), String> {
  let window = get_or_create_quick_panel(&app)?;
  let is_visible = window
    .is_visible()
    .map_err(|err| format!("读取悬浮窗状态失败: {err}"))?;
  if is_visible {
    window.hide().map_err(|err| format!("隐藏悬浮窗失败: {err}"))?;
  } else {
    open_quick_panel(&app)?;
  }
  Ok(())
}

#[tauri::command]
fn hide_quick_panel(app: AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) {
    window.hide().map_err(|err| format!("隐藏悬浮窗失败: {err}"))?;
  }
  Ok(())
}

#[tauri::command]
fn open_main_view(app: AppHandle, view: String) -> Result<(), String> {
  const ALLOWED_VIEWS: &[&str] = &[
    "vault",
    "totp",
    "bookmarks",
    "notes",
    "snippets",
    "subscriptions",
    "devtools",
    "pomodoro",
  ];
  if !ALLOWED_VIEWS.contains(&view.as_str()) {
    return Err("未知工具入口".to_string());
  }
  show_main_window(app.clone())?;
  app
    .emit("omnidesk-open-view", view)
    .map_err(|err| format!("切换工具失败: {err}"))?;
  if let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) {
    let _ = window.hide();
  }
  Ok(())
}

#[cfg(target_os = "macos")]
mod macos_hotkey {
  use super::{emit_hotkey_status, open_quick_panel, AppHandle, GlobalShortcutConfig};
  use std::{
    collections::HashSet,
    ffi::c_void,
    mem, ptr,
    sync::{Mutex, OnceLock},
    thread,
  };
  use tauri::Manager;

  type OSStatus = i32;
  type UInt32 = u32;
  type EventTargetRef = *mut c_void;
  type EventHandlerCallRef = *mut c_void;
  type EventRef = *mut c_void;
  type EventHandlerRef = *mut c_void;
  type EventHotKeyRef = *mut c_void;
  type EventHandlerUPP =
    extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

  #[repr(C)]
  #[derive(Clone, Copy)]
  struct EventTypeSpec {
    event_class: UInt32,
    event_kind: UInt32,
  }

  #[repr(C)]
  #[derive(Clone, Copy, Default)]
  struct EventHotKeyID {
    signature: UInt32,
    id: UInt32,
  }

  #[link(name = "Carbon", kind = "framework")]
  extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
      target: EventTargetRef,
      handler: EventHandlerUPP,
      event_type_count: UInt32,
      event_types: *const EventTypeSpec,
      user_data: *mut c_void,
      handler_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    fn RegisterEventHotKey(
      hot_key_code: UInt32,
      hot_key_modifiers: UInt32,
      hot_key_id: EventHotKeyID,
      target: EventTargetRef,
      options: UInt32,
      hot_key_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
    fn UnregisterEventHotKey(hot_key_ref: EventHotKeyRef) -> OSStatus;
    fn GetEventParameter(
      event: EventRef,
      name: UInt32,
      desired_type: UInt32,
      actual_type: *mut UInt32,
      buffer_size: UInt32,
      actual_size: *mut UInt32,
      data: *mut c_void,
    ) -> OSStatus;
  }

  const fn four_char_code(bytes: [u8; 4]) -> UInt32 {
    ((bytes[0] as UInt32) << 24)
      | ((bytes[1] as UInt32) << 16)
      | ((bytes[2] as UInt32) << 8)
      | bytes[3] as UInt32
  }

  const NO_ERR: OSStatus = 0;
  const CMD_KEY: UInt32 = 1 << 8;
  const SHIFT_KEY: UInt32 = 1 << 9;
  const OPTION_KEY: UInt32 = 1 << 11;
  const CONTROL_KEY: UInt32 = 1 << 12;
  const SPACE_KEY_CODE: UInt32 = 49;
  const HOTKEY_SIGNATURE: UInt32 = four_char_code(*b"OMNI");
  const HOTKEY_QUICK_PANEL: UInt32 = 1;
  const HOTKEY_SCREENSHOT: UInt32 = 2;
  const HOTKEY_COLOR_PICKER: UInt32 = 3;
  const HOTKEY_LOCAL_DROP: UInt32 = 4;
  const EVENT_CLASS_KEYBOARD: UInt32 = four_char_code(*b"keyb");
  const EVENT_HOTKEY_PRESSED: UInt32 = 5;
  const EVENT_PARAM_DIRECT_OBJECT: UInt32 = four_char_code(*b"----");
  const TYPE_EVENT_HOTKEY_ID: UInt32 = four_char_code(*b"hkid");

  #[derive(Default)]
  struct GlobalHotkeyState {
    handler_installed: bool,
    hotkey_refs: Vec<EventHotKeyRef>,
  }

  unsafe impl Send for GlobalHotkeyState {}

  static HOTKEY_STATE: OnceLock<Mutex<GlobalHotkeyState>> = OnceLock::new();

  fn hotkey_state() -> &'static Mutex<GlobalHotkeyState> {
    HOTKEY_STATE.get_or_init(|| Mutex::new(GlobalHotkeyState::default()))
  }

  fn action_id(action: &str) -> Option<UInt32> {
    match action {
      "quickPanel" => Some(HOTKEY_QUICK_PANEL),
      "screenshot" => Some(HOTKEY_SCREENSHOT),
      "colorPicker" => Some(HOTKEY_COLOR_PICKER),
      "localDrop" => Some(HOTKEY_LOCAL_DROP),
      _ => None,
    }
  }

  fn key_code(key: &str) -> Option<UInt32> {
    match key {
      "a" => Some(0),
      "s" => Some(1),
      "d" => Some(2),
      "f" => Some(3),
      "h" => Some(4),
      "g" => Some(5),
      "z" => Some(6),
      "x" => Some(7),
      "c" => Some(8),
      "v" => Some(9),
      "b" => Some(11),
      "q" => Some(12),
      "w" => Some(13),
      "e" => Some(14),
      "r" => Some(15),
      "y" => Some(16),
      "t" => Some(17),
      "1" => Some(18),
      "2" => Some(19),
      "3" => Some(20),
      "4" => Some(21),
      "6" => Some(22),
      "5" => Some(23),
      "=" | "equal" => Some(24),
      "9" => Some(25),
      "7" => Some(26),
      "-" | "minus" => Some(27),
      "8" => Some(28),
      "0" => Some(29),
      "]" | "bracketright" => Some(30),
      "o" => Some(31),
      "u" => Some(32),
      "[" | "bracketleft" => Some(33),
      "i" => Some(34),
      "p" => Some(35),
      "return" | "enter" => Some(36),
      "l" => Some(37),
      "j" => Some(38),
      "'" | "quote" => Some(39),
      "k" => Some(40),
      ";" | "semicolon" => Some(41),
      "\\" | "backslash" => Some(42),
      "," | "comma" => Some(43),
      "/" | "slash" => Some(44),
      "n" => Some(45),
      "m" => Some(46),
      "." | "period" => Some(47),
      "tab" => Some(48),
      "space" => Some(SPACE_KEY_CODE),
      "delete" | "backspace" => Some(51),
      "escape" | "esc" => Some(53),
      _ => None,
    }
  }

  fn parse_accelerator(accelerator: &str) -> Result<(UInt32, UInt32), String> {
    let parts: Vec<String> = accelerator
      .split('+')
      .map(|part| part.trim().to_lowercase())
      .filter(|part| !part.is_empty())
      .collect();

    if parts.len() < 2 {
      return Err(format!("快捷键 `{accelerator}` 至少需要一个修饰键"));
    }

    let mut modifiers = 0;
    for modifier in &parts[..parts.len() - 1] {
      match modifier.as_str() {
        "cmd" | "command" | "meta" | "⌘" => modifiers |= CMD_KEY,
        "option" | "opt" | "alt" | "⌥" => modifiers |= OPTION_KEY,
        "shift" | "⇧" => modifiers |= SHIFT_KEY,
        "ctrl" | "control" | "⌃" => modifiers |= CONTROL_KEY,
        _ => return Err(format!("不支持的修饰键 `{modifier}`")),
      }
    }

    if modifiers == 0 {
      return Err(format!("快捷键 `{accelerator}` 至少需要一个修饰键"));
    }

    let key = parts.last().map(String::as_str).unwrap_or_default();
    let Some(key_code) = key_code(key) else {
      return Err(format!("不支持的按键 `{key}`"));
    };

    Ok((key_code, modifiers))
  }

  extern "C" fn hotkey_handler(
    _next_handler: EventHandlerCallRef,
    event: EventRef,
    user_data: *mut c_void,
  ) -> OSStatus {
    if user_data.is_null() {
      return NO_ERR;
    }

    let mut hotkey_id = EventHotKeyID::default();
    let status = unsafe {
      GetEventParameter(
        event,
        EVENT_PARAM_DIRECT_OBJECT,
        TYPE_EVENT_HOTKEY_ID,
        ptr::null_mut(),
        mem::size_of::<EventHotKeyID>() as UInt32,
        ptr::null_mut(),
        &mut hotkey_id as *mut EventHotKeyID as *mut c_void,
      )
    };

    if status == NO_ERR
      && hotkey_id.signature == HOTKEY_SIGNATURE
    {
      let app = unsafe { &*(user_data as *const AppHandle) };
      match hotkey_id.id {
        HOTKEY_QUICK_PANEL => {
          if let Err(err) = open_quick_panel(app) {
            log::warn!("Failed to open quick panel from global shortcut: {err}");
          }
        }
        HOTKEY_SCREENSHOT => {
          let app = app.clone();
          thread::spawn(move || match super::capture_screenshot(app.clone()) {
            Ok(true) => emit_hotkey_status(&app, "已唤起系统截图，拖选后会复制到剪贴板".to_string()),
            Ok(false) => emit_hotkey_status(&app, "截图已取消".to_string()),
            Err(err) => {
              log::warn!("Failed to capture screenshot from global shortcut: {err}");
              emit_hotkey_status(&app, err);
            }
          });
        }
        HOTKEY_COLOR_PICKER => {
          let app = app.clone();
          thread::spawn(move || match super::pick_screen_color(app.clone(), Some(1_200)) {
            Ok(color) => {
              let message = format!("已复制颜色：{} / {}", color.hex, color.rgb);
              if let Err(err) = super::write_clipboard(color.hex.clone(), None) {
                log::warn!("Failed to copy picked color from global shortcut: {err}");
                emit_hotkey_status(&app, format!("取色成功，但复制失败：{err}"));
              } else {
                emit_hotkey_status(&app, message);
              }
            }
            Err(err) => {
              log::warn!("Failed to pick color from global shortcut: {err}");
              emit_hotkey_status(&app, err);
            }
          });
        }
        HOTKEY_LOCAL_DROP => {
          let app = app.clone();
          thread::spawn(move || {
            let state = app.state::<super::AppState>();
            match super::start_local_drop(app.clone(), state) {
              Ok(info) => {
                let url = info.url.clone();
                if let Err(err) = super::write_clipboard(info.url, None) {
                  log::warn!("Failed to copy local drop URL from global shortcut: {err}");
                  emit_hotkey_status(&app, format!("快传已开启，但复制链接失败：{err}"));
                } else {
                  emit_hotkey_status(&app, format!("快传已开启并复制链接：{url}"));
                }
              }
              Err(err) => {
                log::warn!("Failed to start local drop from global shortcut: {err}");
                emit_hotkey_status(&app, err);
              }
            }
          });
        }
        _ => {}
      }
    }

    NO_ERR
  }

  pub fn default_shortcuts() -> Vec<GlobalShortcutConfig> {
    vec![
      GlobalShortcutConfig {
        action: "quickPanel".to_string(),
        accelerator: "Option+Space".to_string(),
      },
      GlobalShortcutConfig {
        action: "screenshot".to_string(),
        accelerator: "Option+Shift+S".to_string(),
      },
      GlobalShortcutConfig {
        action: "colorPicker".to_string(),
        accelerator: "Option+Shift+C".to_string(),
      },
      GlobalShortcutConfig {
        action: "localDrop".to_string(),
        accelerator: "Option+Shift+D".to_string(),
      },
    ]
  }

  pub fn register_global_shortcuts(
    app: &AppHandle,
    shortcuts: &[GlobalShortcutConfig],
  ) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut parsed_shortcuts = Vec::new();
    for shortcut in shortcuts {
      if shortcut.accelerator.trim().is_empty() {
        continue;
      }
      let Some(action_id) = action_id(shortcut.action.as_str()) else {
        continue;
      };
      let parsed = parse_accelerator(&shortcut.accelerator)?;
      if !seen.insert(parsed) {
        return Err(format!("快捷键 `{}` 重复", shortcut.accelerator));
      }
      parsed_shortcuts.push((action_id, parsed));
    }

    unsafe {
      let target = GetApplicationEventTarget();
      let mut state = hotkey_state()
        .lock()
        .map_err(|_| "全局快捷键状态被占用".to_string())?;

      if !state.handler_installed {
        let event_types = [EventTypeSpec {
          event_class: EVENT_CLASS_KEYBOARD,
          event_kind: EVENT_HOTKEY_PRESSED,
        }];
        let user_data = Box::into_raw(Box::new(app.clone())) as *mut c_void;
        let mut handler_ref: EventHandlerRef = ptr::null_mut();
        let handler_status = InstallEventHandler(
          target,
          hotkey_handler,
          event_types.len() as UInt32,
          event_types.as_ptr(),
          user_data,
          &mut handler_ref,
        );
        if handler_status != NO_ERR {
          let _ = Box::from_raw(user_data as *mut AppHandle);
          return Err(format!("注册全局快捷键事件失败: {handler_status}"));
        }
        state.handler_installed = true;
      }

      for hotkey_ref in state.hotkey_refs.drain(..) {
        let _ = UnregisterEventHotKey(hotkey_ref);
      }

      let mut new_refs = Vec::new();
      for (action_id, (key_code, modifiers)) in parsed_shortcuts {
        let mut hotkey_ref: EventHotKeyRef = ptr::null_mut();
        let hotkey_status = RegisterEventHotKey(
          key_code,
          modifiers,
          EventHotKeyID {
            signature: HOTKEY_SIGNATURE,
            id: action_id,
          },
          target,
          0,
          &mut hotkey_ref,
        );
        if hotkey_status != NO_ERR {
          for registered_ref in new_refs {
            let _ = UnregisterEventHotKey(registered_ref);
          }
          return Err(format!(
            "注册全局快捷键失败，可能与系统或其他应用冲突: {hotkey_status}"
          ));
        }
        new_refs.push(hotkey_ref);
      }
      state.hotkey_refs = new_refs;
    }
    Ok(())
  }
}

#[cfg(target_os = "macos")]
fn register_global_shortcuts(
  app: &AppHandle,
  shortcuts: &[GlobalShortcutConfig],
) -> Result<(), String> {
  macos_hotkey::register_global_shortcuts(app, shortcuts)
}

#[cfg(not(target_os = "macos"))]
fn register_global_shortcuts(
  _app: &AppHandle,
  _shortcuts: &[GlobalShortcutConfig],
) -> Result<(), String> {
  Ok(())
}

#[cfg(target_os = "macos")]
mod macos_screen {
  use std::{ffi::c_void, ptr};

  #[repr(C)]
  #[derive(Clone, Copy)]
  struct CGPoint {
    x: f64,
    y: f64,
  }

  #[repr(C)]
  #[derive(Clone, Copy)]
  struct CGSize {
    width: f64,
    height: f64,
  }

  #[repr(C)]
  #[derive(Clone, Copy)]
  struct CGRect {
    origin: CGPoint,
    size: CGSize,
  }

  #[derive(Clone, Copy)]
  pub struct ScreenSampleTarget {
    pub x: f64,
    pub y: f64,
    pub bounds_x: f64,
    pub bounds_y: f64,
    pub bounds_width: f64,
    pub bounds_height: f64,
  }

  #[link(name = "ApplicationServices", kind = "framework")]
  extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGPreflightScreenCaptureAccess() -> bool;
  }

  #[link(name = "CoreFoundation", kind = "framework")]
  extern "C" {
    fn CFRelease(cf: *const c_void);
  }

  pub fn sample_target() -> Result<ScreenSampleTarget, String> {
    unsafe {
      let event = CGEventCreate(ptr::null());
      if event.is_null() {
        return Err("无法读取当前鼠标位置".to_string());
      }
      let point = CGEventGetLocation(event);
      CFRelease(event as *const c_void);

      let bounds = CGDisplayBounds(CGMainDisplayID());
      Ok(ScreenSampleTarget {
        x: point.x,
        y: point.y,
        bounds_x: bounds.origin.x,
        bounds_y: bounds.origin.y,
        bounds_width: bounds.size.width,
        bounds_height: bounds.size.height,
      })
    }
  }

  pub fn has_screen_capture_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
  }
}

#[cfg(target_os = "macos")]
fn ensure_screen_capture_access() -> Result<(), String> {
  if macos_screen::has_screen_capture_access() {
    return Ok(());
  }

  Err("屏幕录制权限还没有对当前 OmniDesk 进程生效。请在系统设置 > 隐私与安全性 > 录屏与系统录音 中开启 OmniDesk 后，完全退出并重新打开 OmniDesk；如果你刚换了新 .app 包，也需要给新包重新授权。".to_string())
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_capture_access() -> Result<(), String> {
  Ok(())
}

fn now_millis() -> Result<u64, String> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|err| format!("系统时间异常: {err}"))?
      .as_millis() as u64,
  )
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|err| format!("无法定位本地数据目录: {err}"))?;
  fs::create_dir_all(&dir).map_err(|err| format!("无法创建本地数据目录: {err}"))?;
  Ok(dir)
}

fn note_assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app_data_dir(app)?.join(NOTE_ASSET_DIR);
  fs::create_dir_all(&dir).map_err(|err| format!("无法创建笔记图片目录: {err}"))?;
  Ok(dir)
}

fn vault_files_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app_data_dir(app)?.join(VAULT_FILE_DIR);
  fs::create_dir_all(&dir).map_err(|err| format!("无法创建保险箱文件目录: {err}"))?;
  Ok(dir)
}

fn color_sample_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app_data_dir(app)?.join(COLOR_SAMPLE_DIR);
  fs::create_dir_all(&dir).map_err(|err| format!("无法创建取色缓存目录: {err}"))?;
  Ok(dir)
}

fn local_drop_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app_data_dir(app)?.join(LOCAL_DROP_DIR);
  fs::create_dir_all(&dir).map_err(|err| format!("无法创建快传收件箱: {err}"))?;
  Ok(dir)
}

fn exports_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = std::env::var_os("HOME")
    .map(PathBuf::from)
    .map(|home| home.join("Downloads").join(EXPORT_DIR))
    .unwrap_or(app_data_dir(app)?.join("exports"));
  fs::create_dir_all(&dir).map_err(|err| format!("无法创建导出目录: {err}"))?;
  Ok(dir)
}

fn safe_export_file_name(file_name: &str, fallback: &str) -> String {
  let safe = safe_display_file_name(file_name);
  if safe.is_empty() {
    fallback.to_string()
  } else {
    safe
  }
}

fn unique_export_path(dir: &std::path::Path, file_name: &str) -> PathBuf {
  let file_path = PathBuf::from(file_name);
  let stem = file_path
    .file_stem()
    .and_then(|value| value.to_str())
    .filter(|value| !value.is_empty())
    .unwrap_or("omnidesk-export");
  let extension = file_path.extension().and_then(|value| value.to_str());
  let first = dir.join(file_name);
  if !first.exists() {
    return first;
  }

  for index in 1..10_000 {
    let candidate_name = match extension {
      Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
      _ => format!("{stem}-{index}"),
    };
    let candidate = dir.join(candidate_name);
    if !candidate.exists() {
      return candidate;
    }
  }

  dir.join(format!("{stem}-{}", now_millis().unwrap_or_default()))
}

fn export_bytes_to_downloads(
  app: &AppHandle,
  default_file_name: &str,
  bytes: &[u8],
) -> Result<ExportResult, String> {
  if bytes.is_empty() {
    return Err("导出内容为空".to_string());
  }

  let file_name = safe_export_file_name(default_file_name, "omnidesk-export");
  let dir = exports_dir(app)?;
  let path = unique_export_path(&dir, &file_name);
  fs::write(&path, bytes).map_err(|err| format!("写入导出文件失败: {err}"))?;

  Ok(ExportResult {
    exported: true,
    file_name: path
      .file_name()
      .and_then(|value| value.to_str())
      .unwrap_or(&file_name)
      .to_string(),
    path: Some(path.to_string_lossy().to_string()),
  })
}

fn copy_dir_recursive(source: &PathBuf, target: &PathBuf) -> Result<(), String> {
  fs::create_dir_all(target).map_err(|err| format!("创建目录失败: {err}"))?;
  for entry in fs::read_dir(source).map_err(|err| format!("读取目录失败: {err}"))? {
    let entry = entry.map_err(|err| format!("读取目录项失败: {err}"))?;
    let entry_path = entry.path();
    let target_path = target.join(entry.file_name());
    let file_type = entry
      .file_type()
      .map_err(|err| format!("读取文件类型失败: {err}"))?;
    if file_type.is_dir() {
      copy_dir_recursive(&entry_path, &target_path)?;
    } else if file_type.is_file() {
      fs::copy(&entry_path, &target_path).map_err(|err| format!("复制资源文件失败: {err}"))?;
    }
  }
  Ok(())
}

fn dir_has_entries(path: &PathBuf) -> bool {
  path.exists()
    && fs::read_dir(path)
      .map(|mut entries| entries.next().is_some())
      .unwrap_or(false)
}

fn migration_temp_dir(name: &str) -> Result<PathBuf, String> {
  let dir = std::env::temp_dir().join(format!(
    "omnidesk-{name}-{}-{}",
    now_millis()?,
    general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<4>()),
  ));
  fs::create_dir_all(&dir).map_err(|err| format!("创建迁移临时目录失败: {err}"))?;
  Ok(dir)
}

fn vacuum_database_into(app: &AppHandle, target: &PathBuf) -> Result<(), String> {
  let conn = open_database(app)?;
  conn
    .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
    .map_err(|err| format!("整理 SQLite WAL 失败: {err}"))?;
  let target_text = target.to_string_lossy().to_string();
  conn
    .execute("VACUUM INTO ?1", params![target_text])
    .map_err(|err| format!("复制 SQLite 数据库失败: {err}"))?;
  Ok(())
}

fn is_workspace_empty(app: &AppHandle) -> Result<bool, String> {
  let data_dir = app_data_dir(app)?;
  let db_path = data_dir.join(DB_FILE);
  if db_path.exists() {
    let conn = Connection::open(&db_path).map_err(|err| format!("检查本地数据库失败: {err}"))?;
    let app_store_count = conn
      .query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_store'",
        [],
        |row| row.get::<_, i64>(0),
      )
      .unwrap_or(0);
    if app_store_count > 0 {
      let row_count = conn
        .query_row("SELECT COUNT(*) FROM app_store", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0);
      if row_count > 0 {
        return Ok(false);
      }
    }
  }

  for resource_dir in MIGRATION_RESOURCE_DIRS {
    if dir_has_entries(&data_dir.join(resource_dir)) {
      return Ok(false);
    }
  }

  Ok(true)
}

fn find_migration_root(dir: &PathBuf, depth: usize) -> Option<PathBuf> {
  if dir.join(MIGRATION_MANIFEST).exists() && dir.join(DB_FILE).exists() {
    return Some(dir.clone());
  }
  if depth == 0 {
    return None;
  }
  let entries = fs::read_dir(dir).ok()?;
  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_dir() {
      if let Some(root) = find_migration_root(&path, depth - 1) {
        return Some(root);
      }
    }
  }
  None
}

fn replace_path_with_copy(source: &PathBuf, target: &PathBuf) -> Result<(), String> {
  if target.exists() {
    if target.is_dir() {
      fs::remove_dir_all(target).map_err(|err| format!("清理旧目录失败: {err}"))?;
    } else {
      fs::remove_file(target).map_err(|err| format!("清理旧文件失败: {err}"))?;
    }
  }
  if source.is_dir() {
    copy_dir_recursive(source, target)
  } else {
    if let Some(parent) = target.parent() {
      fs::create_dir_all(parent).map_err(|err| format!("创建目标目录失败: {err}"))?;
    }
    fs::copy(source, target).map_err(|err| format!("复制迁移文件失败: {err}"))?;
    Ok(())
  }
}

fn extension_from_mime(mime_type: &str) -> Result<&'static str, String> {
  match mime_type {
    "image/png" => Ok("png"),
    "image/jpeg" | "image/jpg" => Ok("jpg"),
    "image/gif" => Ok("gif"),
    "image/webp" => Ok("webp"),
    "image/bmp" => Ok("bmp"),
    "image/svg+xml" => Ok("svg"),
    _ => Err("只支持保存图片类型的剪贴板内容".to_string()),
  }
}

fn mime_from_extension(extension: &str) -> &'static str {
  match extension.to_ascii_lowercase().as_str() {
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "bmp" => "image/bmp",
    "svg" => "image/svg+xml",
    _ => "application/octet-stream",
  }
}

fn is_safe_asset_file_name(file_name: &str) -> bool {
  !file_name.is_empty()
    && !file_name.contains("..")
    && file_name
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn safe_display_file_name(file_name: &str) -> String {
  file_name
    .chars()
    .filter(|ch| !matches!(ch, '/' | '\\' | ':' | '\0'))
    .collect::<String>()
    .trim()
    .chars()
    .take(120)
    .collect()
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
  let path = app_data_dir(app)?.join(DB_FILE);
  let conn = Connection::open(path).map_err(|err| format!("无法打开 SQLite 数据库: {err}"))?;
  init_database(&conn)?;
  Ok(conn)
}

fn init_database(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      r#"
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_store (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0
      );
      "#,
    )
    .map_err(|err| format!("初始化 SQLite 表失败: {err}"))?;

  if let Err(err) = conn.execute_batch(
    r#"
    CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
      note_id UNINDEXED,
      title,
      content,
      tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS bookmark_fts USING fts5(
      bookmark_id UNINDEXED,
      title,
      url,
      description,
      tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    "#,
  ) {
    log::warn!("SQLite FTS5 is not available, note search will use fallback matching: {err}");
  }
  Ok(())
}

fn persist_global_shortcuts(app: &AppHandle, shortcuts: &[GlobalShortcutConfig]) -> Result<(), String> {
  let conn = open_database(app)?;
  let value = serde_json::to_string(shortcuts).map_err(|err| format!("序列化快捷键失败: {err}"))?;
  conn
    .execute(
      "INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![META_SHORTCUTS_KEY, value],
    )
    .map_err(|err| format!("保存快捷键失败: {err}"))?;
  Ok(())
}

#[cfg(target_os = "macos")]
fn shortcuts_from_preferences_json(
  preferences_json: &str,
  mut shortcuts: Vec<GlobalShortcutConfig>,
) -> Result<Vec<GlobalShortcutConfig>, String> {
  let preferences: Value =
    serde_json::from_str(preferences_json).map_err(|err| format!("解析偏好快捷键失败: {err}"))?;
  let Some(shortcut_map) = preferences.get("shortcuts").and_then(Value::as_object) else {
    return Ok(shortcuts);
  };

  for shortcut in &mut shortcuts {
    if let Some(accelerator) = shortcut_map
      .get(shortcut.action.as_str())
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|value| !value.is_empty())
    {
      shortcut.accelerator = accelerator.to_string();
    }
  }

  Ok(shortcuts)
}

#[cfg(target_os = "macos")]
fn load_startup_global_shortcuts(app: &AppHandle) -> Result<Vec<GlobalShortcutConfig>, String> {
  let conn = open_database(app)?;
  if let Some(value) = conn
    .query_row(
      "SELECT value FROM meta WHERE key = ?1",
      params![META_SHORTCUTS_KEY],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取快捷键失败: {err}"))?
  {
    let shortcuts: Vec<GlobalShortcutConfig> =
      serde_json::from_str(&value).map_err(|err| format!("解析快捷键失败: {err}"))?;
    if !shortcuts.is_empty() {
      return Ok(shortcuts);
    }
  }

  let defaults = macos_hotkey::default_shortcuts();
  if let Some(preferences_json) = conn
    .query_row(
      "SELECT value FROM app_store WHERE key = 'preferences' AND encrypted = 0",
      [],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取偏好快捷键失败: {err}"))?
  {
    return shortcuts_from_preferences_json(&preferences_json, defaults);
  }

  Ok(defaults)
}

fn load_persisted_global_shortcuts(app: &AppHandle) -> Result<Option<Vec<GlobalShortcutConfig>>, String> {
  let conn = open_database(app)?;
  let Some(value) = conn
    .query_row(
      "SELECT value FROM meta WHERE key = ?1",
      params![META_SHORTCUTS_KEY],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取快捷键失败: {err}"))?
  else {
    return Ok(None);
  };

  let shortcuts: Vec<GlobalShortcutConfig> =
    serde_json::from_str(&value).map_err(|err| format!("解析快捷键失败: {err}"))?;
  if shortcuts.is_empty() {
    Ok(None)
  } else {
    Ok(Some(shortcuts))
  }
}

fn merge_persisted_shortcuts_into_store(app: &AppHandle, store: &mut Map<String, Value>) {
  let Some(shortcuts) = load_persisted_global_shortcuts(app)
    .map_err(|err| log::warn!("Failed to load persisted shortcuts into store: {err}"))
    .ok()
    .flatten()
  else {
    return;
  };

  let mut preferences = store
    .get("preferences")
    .and_then(Value::as_object)
    .cloned()
    .unwrap_or_default();
  let mut shortcut_map = preferences
    .get("shortcuts")
    .and_then(Value::as_object)
    .cloned()
    .unwrap_or_default();

  for shortcut in shortcuts {
    shortcut_map.insert(shortcut.action, Value::String(shortcut.accelerator));
  }

  preferences.insert("shortcuts".to_string(), Value::Object(shortcut_map));
  store.insert("preferences".to_string(), Value::Object(preferences));
}

fn string_field(value: &Value, key: &str) -> String {
  value
    .get(key)
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string()
}

fn note_tags_text(note: &Value) -> String {
  note
    .get("tags")
    .and_then(Value::as_array)
    .map(|tags| {
      tags
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ")
    })
    .unwrap_or_default()
}

fn sync_notes_fts(conn: &Connection, notes: &Value) -> Result<(), String> {
  let Some(notes) = notes.as_array() else {
    return Ok(());
  };

  let transaction = conn
    .unchecked_transaction()
    .map_err(|err| format!("开启知识库索引事务失败: {err}"))?;
  transaction
    .execute("DELETE FROM note_fts", [])
    .map_err(|err| format!("清理知识库索引失败: {err}"))?;

  for note in notes {
    let Some(note_id) = note.get("id").and_then(Value::as_str) else {
      continue;
    };

    transaction
      .execute(
        "INSERT INTO note_fts (note_id, title, content, tags) VALUES (?1, ?2, ?3, ?4)",
        params![
          note_id,
          string_field(note, "title"),
          string_field(note, "content"),
          note_tags_text(note),
        ],
      )
      .map_err(|err| format!("写入知识库索引失败: {err}"))?;
  }

  transaction
    .commit()
    .map_err(|err| format!("提交知识库索引失败: {err}"))
}

fn sync_bookmarks_fts(conn: &Connection, bookmarks: &Value) -> Result<(), String> {
  let Some(bookmarks) = bookmarks.as_array() else {
    return Ok(());
  };

  let transaction = conn
    .unchecked_transaction()
    .map_err(|err| format!("开启书签索引事务失败: {err}"))?;
  transaction
    .execute("DELETE FROM bookmark_fts", [])
    .map_err(|err| format!("清理书签索引失败: {err}"))?;

  for bookmark in bookmarks {
    let Some(bookmark_id) = bookmark.get("id").and_then(Value::as_str) else {
      continue;
    };

    transaction
      .execute(
        "INSERT INTO bookmark_fts (bookmark_id, title, url, description, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
          bookmark_id,
          string_field(bookmark, "title"),
          string_field(bookmark, "url"),
          string_field(bookmark, "description"),
          note_tags_text(bookmark),
        ],
      )
      .map_err(|err| format!("写入书签索引失败: {err}"))?;
  }

  transaction
    .commit()
    .map_err(|err| format!("提交书签索引失败: {err}"))
}

fn sync_notes_fts_best_effort(app: &AppHandle, notes: &Value) {
  match open_database(app).and_then(|conn| sync_notes_fts(&conn, notes)) {
    Ok(()) => {}
    Err(err) => log::warn!("Failed to sync note FTS index: {err}"),
  }
}

fn sync_bookmarks_fts_best_effort(app: &AppHandle, bookmarks: &Value) {
  match open_database(app).and_then(|conn| sync_bookmarks_fts(&conn, bookmarks)) {
    Ok(()) => {}
    Err(err) => log::warn!("Failed to sync bookmark FTS index: {err}"),
  }
}

#[derive(Clone)]
struct ChromeBookmarkCandidate {
  title: String,
  url: String,
  created_at: u64,
  profile: String,
  folders: Vec<String>,
}

fn chrome_bookmarks_dirs() -> Vec<(PathBuf, String)> {
  let Some(home) = std::env::var_os("HOME") else {
    return Vec::new();
  };
  let app_support = PathBuf::from(home).join("Library/Application Support");
  let roots = [
    ("Google/Chrome", "Chrome"),
    ("Google/Chrome Beta", "Chrome Beta"),
    ("Google/Chrome Canary", "Chrome Canary"),
  ];
  let mut dirs = Vec::new();

  for (relative_root, browser_label) in roots {
    let root = app_support.join(relative_root);
    let Ok(entries) = fs::read_dir(&root) else {
      continue;
    };

    for entry in entries.flatten() {
      let path = entry.path();
      if !path.is_dir() || !path.join("Bookmarks").is_file() {
        continue;
      }
      let profile_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Profile")
        .to_string();
      dirs.push((path, format!("{browser_label} {profile_name}")));
    }
  }

  dirs.sort_by(|a, b| a.1.cmp(&b.1));
  dirs
}

fn root_folder_label(root_key: &str) -> String {
  match root_key {
    "bookmark_bar" => "书签栏".to_string(),
    "other" => "其他书签".to_string(),
    "synced" => "移动设备书签".to_string(),
    value => value.replace('_', " "),
  }
}

fn chrome_time_to_millis(value: Option<&Value>) -> Option<u64> {
  const CHROME_UNIX_EPOCH_OFFSET_MICROS: i128 = 11_644_473_600_000_000;
  let raw = value
    .and_then(Value::as_str)
    .and_then(|text| text.parse::<i128>().ok())
    .or_else(|| value.and_then(Value::as_i64).map(i128::from))?;
  if raw <= CHROME_UNIX_EPOCH_OFFSET_MICROS {
    return None;
  }
  Some(((raw - CHROME_UNIX_EPOCH_OFFSET_MICROS) / 1_000) as u64)
}

fn bookmark_title_from_url(url: &str) -> String {
  Url::parse(url)
    .ok()
    .and_then(|parsed| parsed.host_str().map(|host| host.trim_start_matches("www.").to_string()))
    .filter(|host| !host.is_empty())
    .unwrap_or_else(|| url.to_string())
}

fn normalize_import_url(url: &str) -> Option<String> {
  let trimmed = url.trim();
  let parsed = Url::parse(trimmed).ok()?;
  match parsed.scheme() {
    "http" | "https" => Some(trimmed.to_string()),
    _ => None,
  }
}

fn favicon_url(url: &str) -> Option<String> {
  let parsed = Url::parse(url).ok()?;
  match parsed.scheme() {
    "http" | "https" => {
      let host = parsed.host_str()?;
      let origin = if let Some(port) = parsed.port() {
        format!("{}://{}:{port}", parsed.scheme(), host)
      } else {
        format!("{}://{}", parsed.scheme(), host)
      };
      Some(format!("{origin}/favicon.ico"))
    }
    _ => None,
  }
}

fn strip_chrome_root_group_path(mut folders: Vec<String>) -> Vec<String> {
  let Some(first) = folders.first() else {
    return folders;
  };
  let normalized = first.trim().to_lowercase();
  if matches!(
    normalized.as_str(),
    "书签栏" | "其他书签" | "移动设备书签" | "bookmarks bar" | "bookmark bar" | "other bookmarks" | "mobile bookmarks"
  ) {
    folders.remove(0);
  }
  folders
}

fn walk_chrome_bookmark_node(
  node: &Value,
  profile: &str,
  folders: &mut Vec<String>,
  output: &mut Vec<ChromeBookmarkCandidate>,
) {
  if let Some(url) = node.get("url").and_then(Value::as_str).and_then(normalize_import_url) {
    let title = node
      .get("name")
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(str::to_string)
      .unwrap_or_else(|| bookmark_title_from_url(&url));
    output.push(ChromeBookmarkCandidate {
      title,
      url,
      created_at: chrome_time_to_millis(node.get("date_added")).unwrap_or_else(|| now_millis().unwrap_or(0)),
      profile: profile.to_string(),
      folders: folders.clone(),
    });
    return;
  }

  let pushed_folder = node
    .get("name")
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| {
      folders.push(value.to_string());
      true
    })
    .unwrap_or(false);

  if let Some(children) = node.get("children").and_then(Value::as_array) {
    for child in children {
      walk_chrome_bookmark_node(child, profile, folders, output);
    }
  }

  if pushed_folder {
    folders.pop();
  }
}

fn read_chrome_bookmarks() -> Result<(Vec<ChromeBookmarkCandidate>, Vec<String>), String> {
  let mut bookmarks = Vec::new();
  let mut profiles = Vec::new();

  for (profile_dir, profile_label) in chrome_bookmarks_dirs() {
    let path = profile_dir.join("Bookmarks");
    let Ok(bytes) = fs::read(&path) else {
      continue;
    };
    let value: Value = serde_json::from_slice(&bytes)
      .map_err(|err| format!("Chrome 书签文件格式无效: {err}"))?;
    profiles.push(profile_label.clone());

    if let Some(roots) = value.get("roots").and_then(Value::as_object) {
      for (root_key, root_node) in roots {
        let mut folders = vec![root_folder_label(root_key)];
        if let Some(children) = root_node.get("children").and_then(Value::as_array) {
          for child in children {
            walk_chrome_bookmark_node(child, &profile_label, &mut folders, &mut bookmarks);
          }
        } else {
          walk_chrome_bookmark_node(root_node, &profile_label, &mut folders, &mut bookmarks);
        }
      }
    }
  }

  Ok((bookmarks, profiles))
}

fn bookmark_dedupe_key(url: &str) -> String {
  Url::parse(url)
    .map(|mut parsed| {
      parsed.set_fragment(None);
      parsed.to_string().trim_end_matches('/').to_lowercase()
    })
    .unwrap_or_else(|_| url.trim().trim_end_matches('/').to_lowercase())
}

fn chrome_bookmark_to_value(bookmark: ChromeBookmarkCandidate, id: String) -> Value {
  let ChromeBookmarkCandidate {
    title,
    url,
    created_at,
    profile,
    folders,
  } = bookmark;
  let icon_url = favicon_url(&url);

  json!({
    "id": id,
    "title": title,
    "url": url,
    "iconUrl": icon_url,
    "tags": [],
    "groupPath": strip_chrome_root_group_path(folders),
    "source": profile,
    "createdAt": created_at,
  })
}

fn fts_query_from_search(query: &str) -> Option<String> {
  let mut terms = Vec::new();
  let mut current = String::new();

  for ch in query.chars() {
    if ch.is_alphanumeric() || ch == '_' {
      current.extend(ch.to_lowercase());
    } else if !current.is_empty() {
      terms.push(format!("{current}*"));
      current.clear();
    }
  }

  if !current.is_empty() {
    terms.push(format!("{current}*"));
  }

  if terms.is_empty() {
    None
  } else {
    Some(terms.join(" AND "))
  }
}

fn search_note_ids_in_value(notes: &Value, query: &str) -> Vec<String> {
  let normalized_query = query.trim().to_lowercase();
  if normalized_query.is_empty() {
    return Vec::new();
  }

  notes
    .as_array()
    .map(|notes| {
      notes
        .iter()
        .filter_map(|note| {
          let id = note.get("id")?.as_str()?;
          let haystack = format!(
            "{} {} {}",
            string_field(note, "title"),
            string_field(note, "content"),
            note_tags_text(note),
          )
          .to_lowercase();

          haystack
            .contains(&normalized_query)
            .then(|| id.to_string())
        })
        .collect()
    })
    .unwrap_or_default()
}

fn search_note_ids_with_fts(conn: &Connection, query: &str) -> Result<Vec<String>, String> {
  let Some(fts_query) = fts_query_from_search(query) else {
    return Ok(Vec::new());
  };

  let mut statement = conn
    .prepare(
      "SELECT note_id
       FROM note_fts
       WHERE note_fts MATCH ?1
       ORDER BY bm25(note_fts, 6.0, 2.0, 1.0)
       LIMIT 300",
    )
    .map_err(|err| format!("准备知识库全文搜索失败: {err}"))?;
  let rows = statement
    .query_map(params![fts_query], |row| row.get::<_, String>(0))
    .map_err(|err| format!("查询知识库全文索引失败: {err}"))?;

  let mut ids = Vec::new();
  for row in rows {
    ids.push(row.map_err(|err| format!("读取知识库全文结果失败: {err}"))?);
  }
  Ok(ids)
}

fn search_bookmark_ids_in_value(bookmarks: &Value, query: &str) -> Vec<String> {
  let normalized_query = query.trim().to_lowercase();
  if normalized_query.is_empty() {
    return Vec::new();
  }

  bookmarks
    .as_array()
    .map(|bookmarks| {
      bookmarks
        .iter()
        .filter_map(|bookmark| {
          let id = bookmark.get("id")?.as_str()?;
          let haystack = format!(
            "{} {} {} {}",
            string_field(bookmark, "title"),
            string_field(bookmark, "url"),
            string_field(bookmark, "description"),
            note_tags_text(bookmark),
          )
          .to_lowercase();

          haystack
            .contains(&normalized_query)
            .then(|| id.to_string())
        })
        .collect()
    })
    .unwrap_or_default()
}

fn search_bookmark_ids_with_fts(conn: &Connection, query: &str) -> Result<Vec<String>, String> {
  let Some(fts_query) = fts_query_from_search(query) else {
    return Ok(Vec::new());
  };

  let mut statement = conn
    .prepare(
      "SELECT bookmark_id
       FROM bookmark_fts
       WHERE bookmark_fts MATCH ?1
       ORDER BY bm25(bookmark_fts, 6.0, 4.0, 2.0, 1.0)
       LIMIT 300",
    )
    .map_err(|err| format!("准备书签全文搜索失败: {err}"))?;
  let rows = statement
    .query_map(params![fts_query], |row| row.get::<_, String>(0))
    .map_err(|err| format!("查询书签全文索引失败: {err}"))?;

  let mut ids = Vec::new();
  for row in rows {
    ids.push(row.map_err(|err| format!("读取书签全文结果失败: {err}"))?);
  }
  Ok(ids)
}

fn is_sensitive_store_key(key: &str) -> bool {
  SENSITIVE_STORE_KEYS.contains(&key)
}

fn encode_store_value(store_key: &str, value: &Value, key: &[u8; 32]) -> Result<(String, i64), String> {
  if is_sensitive_store_key(store_key) {
    let plaintext = serde_json::to_vec(value).map_err(|err| format!("序列化 {store_key} 失败: {err}"))?;
    let (nonce, ciphertext) = encrypt_bytes(key, &plaintext)?;
    let payload = EncryptedPayload {
      version: 1,
      nonce,
      ciphertext,
    };
    Ok((
      serde_json::to_string(&payload).map_err(|err| format!("序列化 {store_key} 密文失败: {err}"))?,
      1,
    ))
  } else {
    Ok((
      serde_json::to_string(value).map_err(|err| format!("序列化 {store_key} 失败: {err}"))?,
      0,
    ))
  }
}

fn decode_store_value(
  store_key: &str,
  stored_value: &str,
  encrypted: i64,
  key: &[u8; 32],
) -> Result<Value, String> {
  if encrypted == 1 {
    let payload: EncryptedPayload =
      serde_json::from_str(stored_value).map_err(|err| format!("{store_key} 密文记录无效: {err}"))?;
    let plaintext = decrypt_bytes(key, &payload.nonce, &payload.ciphertext)?;
    serde_json::from_slice(&plaintext).map_err(|err| format!("{store_key} 数据 JSON 无效: {err}"))
  } else {
    serde_json::from_str(stored_value).map_err(|err| format!("{store_key} 数据 JSON 无效: {err}"))
  }
}

fn load_store_map(app: &AppHandle, key: &[u8; 32]) -> Result<Map<String, Value>, String> {
  let conn = open_database(app)?;
  let mut statement = conn
    .prepare("SELECT key, value, encrypted FROM app_store ORDER BY key")
    .map_err(|err| format!("读取本地数据失败: {err}"))?;
  let rows = statement
    .query_map([], |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, i64>(2)?,
      ))
    })
    .map_err(|err| format!("查询本地数据失败: {err}"))?;

  let mut store = Map::new();
  for row in rows {
    let (store_key, stored_value, encrypted) =
      row.map_err(|err| format!("读取本地数据行失败: {err}"))?;
    let value = decode_store_value(&store_key, &stored_value, encrypted, key)?;
    store.insert(store_key, value);
  }
  Ok(store)
}

fn persist_store_map(app: &AppHandle, key: &[u8; 32], store: &Map<String, Value>) -> Result<(), String> {
  let mut conn = open_database(app)?;
  let transaction = conn
    .transaction()
    .map_err(|err| format!("开启 SQLite 事务失败: {err}"))?;
  transaction
    .execute("DELETE FROM app_store", [])
    .map_err(|err| format!("清理旧数据失败: {err}"))?;

  for (store_key, value) in store {
    let (stored_value, encrypted) = encode_store_value(store_key, value, key)?;
    transaction
      .execute(
        "INSERT INTO app_store (key, value, encrypted) VALUES (?1, ?2, ?3)",
        params![store_key, stored_value, encrypted],
      )
      .map_err(|err| format!("写入 {store_key} 失败: {err}"))?;
  }

  transaction
    .commit()
    .map_err(|err| format!("提交 SQLite 事务失败: {err}"))?;

  if let Some(notes) = store.get("notes") {
    sync_notes_fts_best_effort(app, notes);
  }
  if let Some(bookmarks) = store.get("bookmarks") {
    sync_bookmarks_fts_best_effort(app, bookmarks);
  }

  Ok(())
}

fn flush_cached_store(app: &AppHandle, state: &RuntimeState) -> Result<(), String> {
  let Some(key) = *state
    .key
    .lock()
    .map_err(|_| "无法访问加密会话".to_string())?
  else {
    return Ok(());
  };

  let Some(store) = state
    .cache
    .lock()
    .map_err(|_| "无法访问 Rust 内存缓存".to_string())?
    .clone()
  else {
    return Ok(());
  };

  persist_store_map(app, &key, &store)
}

fn schedule_cache_flush(app: AppHandle, state: AppState) {
  let generation = state.flush_generation.fetch_add(1, Ordering::SeqCst) + 1;
  thread::spawn(move || {
    thread::sleep(Duration::from_millis(350));
    if state.flush_generation.load(Ordering::SeqCst) != generation {
      return;
    }
    if let Err(err) = flush_cached_store(&app, state.as_ref()) {
      log::error!("Failed to flush OmniDesk SQLite cache: {err}");
    }
  });
}

fn random_bytes<const N: usize>() -> [u8; N] {
  let mut bytes = [0u8; N];
  OsRng.fill_bytes(&mut bytes);
  bytes
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
  let mut key = [0u8; 32];
  let params = Params::new(64 * 1024, 3, 1, Some(32))
    .map_err(|err| format!("无法初始化加密参数: {err}"))?;
  let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
  argon2
    .hash_password_into(password.as_bytes(), salt, &mut key)
    .map_err(|err| format!("无法派生主密钥: {err}"))?;
  Ok(key)
}

fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<(String, String), String> {
  let nonce_bytes = random_bytes::<12>();
  let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "无法初始化 AES-256-GCM".to_string())?;
  let ciphertext = cipher
    .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
    .map_err(|_| "加密失败".to_string())?;
  Ok((
    general_purpose::STANDARD.encode(nonce_bytes),
    general_purpose::STANDARD.encode(ciphertext),
  ))
}

fn decrypt_bytes(key: &[u8; 32], nonce: &str, ciphertext: &str) -> Result<Vec<u8>, String> {
  let nonce_bytes = general_purpose::STANDARD
    .decode(nonce)
    .map_err(|_| "加密文件 nonce 无效".to_string())?;
  let ciphertext_bytes = general_purpose::STANDARD
    .decode(ciphertext)
    .map_err(|_| "加密文件内容无效".to_string())?;
  let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "无法初始化 AES-256-GCM".to_string())?;
  cipher
    .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext_bytes.as_ref())
    .map_err(|_| "主密码错误或本地数据已损坏".to_string())
}

fn current_key(state: &RuntimeState) -> Result<[u8; 32], String> {
  state
    .key
    .lock()
    .map_err(|_| "无法访问加密会话".to_string())?
    .ok_or_else(|| "工作区尚未解锁".to_string())
}

fn read_master_record(conn: &Connection) -> Result<Option<MasterRecord>, String> {
  let record_json = conn
    .query_row(
      "SELECT value FROM meta WHERE key = ?1",
      params![META_MASTER_KEY],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("读取主密钥记录失败: {err}"))?;

  record_json
    .map(|value| serde_json::from_str(&value).map_err(|err| format!("主密钥记录无效: {err}")))
    .transpose()
}

fn verify_master_password(record: &MasterRecord, password: &str) -> Result<[u8; 32], String> {
  let salt = general_purpose::STANDARD
    .decode(&record.salt)
    .map_err(|_| "主密钥盐值无效".to_string())?;
  let key = derive_key(password, &salt)?;
  let verifier = decrypt_bytes(&key, &record.nonce, &record.verifier)?;
  if verifier != VERIFIER_TEXT {
    return Err("主密码错误".to_string());
  }
  Ok(key)
}

fn create_master_record(password: &str) -> Result<(MasterRecord, [u8; 32]), String> {
  let salt = random_bytes::<16>();
  let key = derive_key(password, &salt)?;
  let (nonce, verifier) = encrypt_bytes(&key, VERIFIER_TEXT)?;
  Ok((
    MasterRecord {
      version: 1,
      kdf: "argon2id-v19:m=65536,t=3,p=1".to_string(),
      salt: general_purpose::STANDARD.encode(salt),
      nonce,
      verifier,
    },
    key,
  ))
}

fn write_master_record(conn: &Connection, record: &MasterRecord) -> Result<(), String> {
  let record_json =
    serde_json::to_string(record).map_err(|err| format!("序列化主密钥记录失败: {err}"))?;
  conn
    .execute(
      "INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![META_MASTER_KEY, record_json],
    )
    .map_err(|err| format!("写入主密钥记录失败: {err}"))?;
  Ok(())
}

#[tauri::command]
fn unlock(app: AppHandle, state: State<AppState>, password: String) -> Result<(), String> {
  if password.trim().is_empty() {
    return Err("主密码不能为空".to_string());
  }

  let conn = open_database(&app)?;
  let record = read_master_record(&conn)?;

  let key = if let Some(record) = record {
    verify_master_password(&record, &password)?
  } else {
    let (record, key) = create_master_record(&password)?;
    write_master_record(&conn, &record)?;
    key
  };

  *state
    .key
    .lock()
    .map_err(|_| "无法保存加密会话".to_string())? = Some(key);
  *state
    .cache
    .lock()
    .map_err(|_| "无法初始化 Rust 内存缓存".to_string())? = None;
  Ok(())
}

#[tauri::command]
fn change_master_password(
  app: AppHandle,
  state: State<AppState>,
  current_password: String,
  new_password: String,
) -> Result<(), String> {
  if new_password.trim().len() < 8 {
    return Err("新主密码至少需要 8 位".to_string());
  }
  if current_password == new_password {
    return Err("新主密码不能与当前主密码相同".to_string());
  }

  current_key(state.inner().as_ref())?;

  let conn = open_database(&app)?;
  let record = read_master_record(&conn)?.ok_or_else(|| "主密码尚未初始化".to_string())?;
  let old_key = verify_master_password(&record, &current_password)?;

  let store = if let Some(cache) = state
    .cache
    .lock()
    .map_err(|_| "无法读取 Rust 内存缓存".to_string())?
    .clone()
  {
    cache
  } else {
    load_store_map(&app, &old_key)?
  };

  let (new_record, new_key) = create_master_record(&new_password)?;
  write_master_record(&conn, &new_record)?;
  persist_store_map(&app, &new_key, &store)?;

  *state
    .key
    .lock()
    .map_err(|_| "无法更新加密会话".to_string())? = Some(new_key);
  *state
    .cache
    .lock()
    .map_err(|_| "无法更新 Rust 内存缓存".to_string())? = Some(store);
  Ok(())
}

#[tauri::command]
fn verify_password(app: AppHandle, password: String) -> Result<(), String> {
  if password.trim().is_empty() {
    return Err("主密码不能为空".to_string());
  }

  let conn = open_database(&app)?;
  let record = read_master_record(&conn)?.ok_or_else(|| "主密码尚未初始化".to_string())?;
  verify_master_password(&record, &password).map(|_| ())
}

#[tauri::command]
fn lock_store(app: AppHandle, state: State<AppState>) -> Result<(), String> {
  flush_cached_store(&app, state.inner().as_ref())?;
  *state
    .key
    .lock()
    .map_err(|_| "无法清理加密会话".to_string())? = None;
  *state
    .cache
    .lock()
    .map_err(|_| "无法清理 Rust 内存缓存".to_string())? = None;
  Ok(())
}

#[tauri::command]
fn load_store(app: AppHandle, state: State<AppState>) -> Result<Value, String> {
  if let Some(cache) = state
    .cache
    .lock()
    .map_err(|_| "无法读取 Rust 内存缓存".to_string())?
    .clone()
  {
    return Ok(Value::Object(cache));
  }

  let key = current_key(state.inner().as_ref())?;
  let mut store = load_store_map(&app, &key)?;
  merge_persisted_shortcuts_into_store(&app, &mut store);
  if let Some(notes) = store.get("notes") {
    sync_notes_fts_best_effort(&app, notes);
  }
  if let Some(bookmarks) = store.get("bookmarks") {
    sync_bookmarks_fts_best_effort(&app, bookmarks);
  }
  *state
    .cache
    .lock()
    .map_err(|_| "无法写入 Rust 内存缓存".to_string())? = Some(store.clone());
  Ok(Value::Object(store))
}

#[tauri::command]
fn save_store(app: AppHandle, state: State<AppState>, store: Value) -> Result<(), String> {
  let object = store
    .as_object()
    .ok_or_else(|| "本地数据必须是对象".to_string())?;
  let key = current_key(state.inner().as_ref())?;
  let cache = object.clone();
  *state
    .cache
    .lock()
    .map_err(|_| "无法更新 Rust 内存缓存".to_string())? = Some(cache.clone());
  persist_store_map(&app, &key, &cache)
}

#[tauri::command]
fn save_store_item(
  app: AppHandle,
  state: State<AppState>,
  store_key: String,
  value: Value,
) -> Result<(), String> {
  if store_key.trim().is_empty() {
    return Err("存储 key 不能为空".to_string());
  }

  let key = current_key(state.inner().as_ref())?;
  let notes_for_index = (store_key == "notes").then(|| value.clone());
  let bookmarks_for_index = (store_key == "bookmarks").then(|| value.clone());
  let needs_load = state
    .cache
    .lock()
    .map_err(|_| "无法读取 Rust 内存缓存".to_string())?
    .is_none();

  if needs_load {
    let loaded = load_store_map(&app, &key)?;
    let mut cache = state
      .cache
      .lock()
      .map_err(|_| "无法初始化 Rust 内存缓存".to_string())?;
    if cache.is_none() {
      *cache = Some(loaded);
    }
  }

  {
    let mut cache = state
      .cache
      .lock()
      .map_err(|_| "无法更新 Rust 内存缓存".to_string())?;
    let store = cache.as_mut().ok_or_else(|| "Rust 内存缓存未初始化".to_string())?;
    store.insert(store_key, value);
  }

  if let Some(notes) = notes_for_index {
    sync_notes_fts_best_effort(&app, &notes);
  }
  if let Some(bookmarks) = bookmarks_for_index {
    sync_bookmarks_fts_best_effort(&app, &bookmarks);
  }

  schedule_cache_flush(app, state.inner().clone());
  Ok(())
}

#[tauri::command]
fn search_notes(
  app: AppHandle,
  state: State<AppState>,
  query: String,
  notes: Option<Value>,
) -> Result<Vec<String>, String> {
  let trimmed_query = query.trim();
  if trimmed_query.is_empty() {
    return Ok(Vec::new());
  }

  let key = current_key(state.inner().as_ref())?;
  let notes_for_fallback = if notes.as_ref().and_then(Value::as_array).is_some() {
    notes
  } else if let Some(cache_notes) = state
    .cache
    .lock()
    .map_err(|_| "无法读取 Rust 内存缓存".to_string())?
    .as_ref()
    .and_then(|cache| cache.get("notes").cloned())
  {
    Some(cache_notes)
  } else {
    load_store_map(&app, &key)?.get("notes").cloned()
  };

  if let Some(note_value) = &notes_for_fallback {
    sync_notes_fts_best_effort(&app, note_value);
  }

  let mut ids = match open_database(&app).and_then(|conn| search_note_ids_with_fts(&conn, trimmed_query)) {
    Ok(ids) => ids,
    Err(err) => {
      log::warn!("Note FTS search failed, using fallback matching: {err}");
      Vec::new()
    }
  };

  if let Some(note_value) = &notes_for_fallback {
    let mut seen: HashSet<String> = ids.iter().cloned().collect();
    for id in search_note_ids_in_value(note_value, trimmed_query) {
      if seen.insert(id.clone()) {
        ids.push(id);
      }
    }
  }

  Ok(ids)
}

#[tauri::command]
fn search_bookmarks(
  app: AppHandle,
  state: State<AppState>,
  query: String,
  bookmarks: Option<Value>,
) -> Result<Vec<String>, String> {
  let trimmed_query = query.trim();
  if trimmed_query.is_empty() {
    return Ok(Vec::new());
  }

  let key = current_key(state.inner().as_ref())?;
  let bookmarks_for_fallback = if bookmarks.as_ref().and_then(Value::as_array).is_some() {
    bookmarks
  } else if let Some(cache_bookmarks) = state
    .cache
    .lock()
    .map_err(|_| "无法读取 Rust 内存缓存".to_string())?
    .as_ref()
    .and_then(|cache| cache.get("bookmarks").cloned())
  {
    Some(cache_bookmarks)
  } else {
    load_store_map(&app, &key)?.get("bookmarks").cloned()
  };

  if let Some(bookmark_value) = &bookmarks_for_fallback {
    sync_bookmarks_fts_best_effort(&app, bookmark_value);
  }

  let mut ids = match open_database(&app).and_then(|conn| search_bookmark_ids_with_fts(&conn, trimmed_query)) {
    Ok(ids) => ids,
    Err(err) => {
      log::warn!("Bookmark FTS search failed, using fallback matching: {err}");
      Vec::new()
    }
  };

  if let Some(bookmark_value) = &bookmarks_for_fallback {
    let mut seen: HashSet<String> = ids.iter().cloned().collect();
    for id in search_bookmark_ids_in_value(bookmark_value, trimmed_query) {
      if seen.insert(id.clone()) {
        ids.push(id);
      }
    }
  }

  Ok(ids)
}

#[cfg(target_os = "macos")]
fn read_system_idle_millis() -> Result<u64, String> {
  let output = Command::new("/usr/sbin/ioreg")
    .args(["-c", "IOHIDSystem"])
    .output()
    .map_err(|err| format!("读取系统空闲时间失败: {err}"))?;

  if !output.status.success() {
    return Err("读取系统空闲时间失败".to_string());
  }

  let text = String::from_utf8_lossy(&output.stdout);
  let idle_nanos = text
    .lines()
    .find_map(|line| {
      let (_, value) = line.split_once("HIDIdleTime")?;
      let (_, value) = value.split_once('=')?;
      value.trim().parse::<u64>().ok()
    })
    .ok_or_else(|| "无法解析系统空闲时间".to_string())?;

  Ok(idle_nanos / 1_000_000)
}

#[cfg(not(target_os = "macos"))]
fn read_system_idle_millis() -> Result<u64, String> {
  Err("当前平台暂不支持系统级空闲检测".to_string())
}

#[tauri::command]
fn system_idle_millis() -> Result<u64, String> {
  read_system_idle_millis()
}

#[tauri::command]
fn write_clipboard(text: String, clear_after_seconds: Option<u64>) -> Result<(), String> {
  let mut clipboard = arboard::Clipboard::new().map_err(|err| format!("无法访问剪贴板: {err}"))?;
  clipboard
    .set_text(text)
    .map_err(|err| format!("写入剪贴板失败: {err}"))?;

  if let Some(seconds) = clear_after_seconds {
    let seconds = seconds.clamp(15, 30);
    let expected_text = clipboard
      .get_text()
      .unwrap_or_default();
    thread::spawn(move || {
      thread::sleep(Duration::from_secs(seconds));
      let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return;
      };
      let Ok(current_text) = clipboard.get_text() else {
        return;
      };
      if current_text == expected_text {
        let _ = clipboard.set_text(String::new());
      }
    });
  }

  Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  let parsed = Url::parse(&url).map_err(|_| "URL 格式无效".to_string())?;
  match parsed.scheme() {
    "http" | "https" => open::that(parsed.as_str()).map_err(|err| format!("打开链接失败: {err}")),
    _ => Err("只允许打开 http/https 链接".to_string()),
  }
}

#[tauri::command]
fn export_json(app: AppHandle, default_file_name: String, data: Value) -> Result<ExportResult, String> {
  let bytes = serde_json::to_vec_pretty(&data).map_err(|err| format!("导出 JSON 失败: {err}"))?;
  export_bytes_to_downloads(&app, &default_file_name, &bytes)
}

#[tauri::command]
fn export_workspace_archive(app: AppHandle, state: State<AppState>) -> Result<ExportResult, String> {
  flush_cached_store(&app, state.inner().as_ref())?;

  let staged_root = migration_temp_dir("workspace-export")?;
  let created_at = now_millis()?;
  let archive_name = format!("omnidesk-workspace-{created_at}.zip");
  let archive_path = unique_export_path(&exports_dir(&app)?, &archive_name);

  let result = (|| -> Result<ExportResult, String> {
    let staged_db = staged_root.join(DB_FILE);
    vacuum_database_into(&app, &staged_db)?;

    let data_dir = app_data_dir(&app)?;
    for resource_dir in MIGRATION_RESOURCE_DIRS {
      let source = data_dir.join(resource_dir);
      if source.exists() {
        copy_dir_recursive(&source, &staged_root.join(resource_dir))?;
      }
    }

    let manifest = json!({
      "formatVersion": 1,
      "product": "OmniDesk",
      "createdAt": created_at,
      "contains": {
        "database": DB_FILE,
        "resourceDirs": MIGRATION_RESOURCE_DIRS,
      },
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|err| format!("生成迁移清单失败: {err}"))?;
    fs::write(staged_root.join(MIGRATION_MANIFEST), manifest_bytes)
      .map_err(|err| format!("写入迁移清单失败: {err}"))?;

    let status = Command::new("/usr/bin/ditto")
      .arg("-c")
      .arg("-k")
      .arg("--sequesterRsrc")
      .arg("--keepParent")
      .arg(&staged_root)
      .arg(&archive_path)
      .status()
      .map_err(|err| format!("启动整包导出失败: {err}"))?;
    if !status.success() {
      return Err(format!("整包导出失败: {status}"));
    }

    Ok(ExportResult {
      exported: true,
      file_name: archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&archive_name)
        .to_string(),
      path: Some(archive_path.to_string_lossy().to_string()),
    })
  })();

  let _ = fs::remove_dir_all(&staged_root);
  result
}

#[tauri::command]
fn import_workspace_archive(app: AppHandle, state: State<AppState>) -> Result<ExportResult, String> {
  if !is_workspace_empty(&app)? {
    return Err("当前本地已有数据，整包导入只允许在空项目中执行。请先在新电脑/空工作区导入。".to_string());
  }

  let archive_path = rfd::FileDialog::new()
    .add_filter("OmniDesk Workspace", &["zip"])
    .pick_file();
  let Some(archive_path) = archive_path else {
    return Ok(ExportResult {
      exported: false,
      file_name: String::new(),
      path: None,
    });
  };

  let extract_root = migration_temp_dir("workspace-import")?;
  let result = (|| -> Result<ExportResult, String> {
    let status = Command::new("/usr/bin/ditto")
      .arg("-x")
      .arg("-k")
      .arg(&archive_path)
      .arg(&extract_root)
      .status()
      .map_err(|err| format!("启动整包导入失败: {err}"))?;
    if !status.success() {
      return Err(format!("整包解压失败: {status}"));
    }

    let migration_root = find_migration_root(&extract_root, 3)
      .ok_or_else(|| "不是有效的 OmniDesk 整包备份".to_string())?;
    let manifest_bytes = fs::read(migration_root.join(MIGRATION_MANIFEST))
      .map_err(|err| format!("读取迁移清单失败: {err}"))?;
    let manifest: Value =
      serde_json::from_slice(&manifest_bytes).map_err(|err| format!("迁移清单无效: {err}"))?;
    if manifest
      .get("formatVersion")
      .and_then(Value::as_i64)
      .unwrap_or_default()
      != 1
    {
      return Err("不支持的 OmniDesk 备份版本".to_string());
    }

    let imported_db = migration_root.join(DB_FILE);
    if !imported_db.exists() {
      return Err("备份中缺少 SQLite 数据库".to_string());
    }

    if let Some(server) = state
      .inner()
      .as_ref()
      .local_drop
      .lock()
      .map_err(|_| "快传服务状态被占用".to_string())?
      .take()
    {
      server.stop.store(true, Ordering::SeqCst);
    }

    let data_dir = app_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|err| format!("创建本地数据目录失败: {err}"))?;
    for suffix in ["", "-wal", "-shm"] {
      let db_related = data_dir.join(format!("{DB_FILE}{suffix}"));
      if db_related.exists() {
        fs::remove_file(&db_related).map_err(|err| format!("清理旧数据库失败: {err}"))?;
      }
    }
    replace_path_with_copy(&imported_db, &data_dir.join(DB_FILE))?;

    for resource_dir in MIGRATION_RESOURCE_DIRS {
      let source = migration_root.join(resource_dir);
      let target = data_dir.join(resource_dir);
      if source.exists() {
        replace_path_with_copy(&source, &target)?;
      } else if target.exists() {
        fs::remove_dir_all(&target).map_err(|err| format!("清理旧资源目录失败: {err}"))?;
      }
    }

    *state
      .inner()
      .as_ref()
      .key
      .lock()
      .map_err(|_| "无法清理加密会话".to_string())? = None;
    *state
      .inner()
      .as_ref()
      .cache
      .lock()
      .map_err(|_| "无法清理 Rust 内存缓存".to_string())? = None;

    Ok(ExportResult {
      exported: true,
      file_name: archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("omnidesk-workspace.zip")
        .to_string(),
      path: Some(archive_path.to_string_lossy().to_string()),
    })
  })();

  let _ = fs::remove_dir_all(&extract_root);
  result
}

#[tauri::command]
fn export_bytes(
  app: AppHandle,
  default_file_name: String,
  bytes_base64: String,
) -> Result<ExportResult, String> {
  let bytes = general_purpose::STANDARD
    .decode(bytes_base64)
    .map_err(|_| "导出内容不是有效的 Base64".to_string())?;
  export_bytes_to_downloads(&app, &default_file_name, &bytes)
}

#[tauri::command]
fn import_json() -> Result<Option<Value>, String> {
  let path = rfd::FileDialog::new()
    .add_filter("JSON", &["json"])
    .pick_file();

  let Some(path) = path else {
    return Ok(None);
  };

  let bytes = fs::read(path).map_err(|err| format!("读取导入文件失败: {err}"))?;
  let value = serde_json::from_slice(&bytes).map_err(|err| format!("导入文件不是有效 JSON: {err}"))?;
  Ok(Some(value))
}

#[tauri::command]
fn import_chrome_bookmarks(
  app: AppHandle,
  state: State<AppState>,
) -> Result<ChromeBookmarkImportResult, String> {
  let (candidates, profiles) = read_chrome_bookmarks()?;
  let found = candidates.len();
  if found == 0 {
    return Ok(ChromeBookmarkImportResult {
      found,
      imported: 0,
      skipped: 0,
      profiles,
    });
  }

  let key = current_key(state.inner().as_ref())?;
  let mut store = if let Some(cache) = state
    .inner()
    .as_ref()
    .cache
    .lock()
    .map_err(|_| "无法读取 Rust 内存缓存".to_string())?
    .clone()
  {
    cache
  } else {
    let mut loaded = load_store_map(&app, &key)?;
    merge_persisted_shortcuts_into_store(&app, &mut loaded);
    loaded
  };

  let mut existing_bookmarks = store
    .get("bookmarks")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
  let mut seen_urls = HashSet::new();
  for bookmark in &existing_bookmarks {
    if let Some(url) = bookmark.get("url").and_then(Value::as_str) {
      seen_urls.insert(bookmark_dedupe_key(url));
    }
  }

  let imported_at = now_millis()?;
  let mut imported_bookmarks = Vec::new();
  let mut skipped = 0;
  for candidate in candidates {
    let dedupe_key = bookmark_dedupe_key(&candidate.url);
    if !seen_urls.insert(dedupe_key) {
      skipped += 1;
      continue;
    }
    let id = format!("chrome-{imported_at}-{}", imported_bookmarks.len() + 1);
    imported_bookmarks.push(chrome_bookmark_to_value(candidate, id));
  }

  let imported = imported_bookmarks.len();
  if imported > 0 {
    imported_bookmarks.append(&mut existing_bookmarks);
    store.insert("bookmarks".to_string(), Value::Array(imported_bookmarks));
    persist_store_map(&app, &key, &store)?;
    *state
      .inner()
      .as_ref()
      .cache
      .lock()
      .map_err(|_| "无法更新 Rust 内存缓存".to_string())? = Some(store);
  }

  Ok(ChromeBookmarkImportResult {
    found,
    imported,
    skipped,
    profiles,
  })
}

#[tauri::command]
fn save_note_image(
  app: AppHandle,
  mime_type: String,
  bytes_base64: String,
) -> Result<SavedNoteImage, String> {
  let extension = extension_from_mime(mime_type.trim())?;
  let bytes = general_purpose::STANDARD
    .decode(bytes_base64)
    .map_err(|_| "图片数据不是有效的 Base64".to_string())?;

  if bytes.is_empty() {
    return Err("图片内容为空".to_string());
  }
  if bytes.len() > MAX_NOTE_IMAGE_BYTES {
    return Err("图片太大，单张最多 20MB".to_string());
  }

  let millis = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|err| format!("无法生成图片文件名: {err}"))?
    .as_millis();
  let random = random_bytes::<4>();
  let file_name = format!(
    "note-image-{millis}-{}.{}",
    general_purpose::URL_SAFE_NO_PAD.encode(random),
    extension,
  );
  let path = note_assets_dir(&app)?.join(&file_name);
  fs::write(&path, bytes).map_err(|err| format!("写入笔记图片失败: {err}"))?;

  Ok(SavedNoteImage {
    markdown_src: format!("{NOTE_ASSET_PREFIX}{file_name}"),
    file_name,
  })
}

#[tauri::command]
fn read_note_image(app: AppHandle, src: String) -> Result<String, String> {
  let file_name = src
    .strip_prefix(NOTE_ASSET_PREFIX)
    .ok_or_else(|| "不是 OmniDesk 本地图片引用".to_string())?;
  if !is_safe_asset_file_name(file_name) {
    return Err("图片文件名无效".to_string());
  }

  let path = note_assets_dir(&app)?.join(file_name);
  let bytes = fs::read(&path).map_err(|err| format!("读取笔记图片失败: {err}"))?;
  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default();
  let mime_type = mime_from_extension(extension);
  Ok(format!(
    "data:{mime_type};base64,{}",
    general_purpose::STANDARD.encode(bytes),
  ))
}

#[tauri::command]
fn capture_screenshot(app: AppHandle) -> Result<bool, String> {
  if !cfg!(target_os = "macos") {
    return Err("当前仅支持 macOS 系统截图".to_string());
  }

  if let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) {
    let _ = window.hide();
  }
  thread::sleep(Duration::from_millis(120));

  let output = Command::new("/usr/bin/osascript")
    .arg("-e")
    .arg(
      r#"tell application "System Events" to key code 21 using {control down, shift down, command down}"#,
    )
    .output()
    .map_err(|err| format!("唤起系统截图快捷键失败: {err}"))?;

  if output.status.success() {
    Ok(true)
  } else {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr.trim();
    if message.is_empty() {
      Err(format!("系统截图快捷键唤起失败: {}", output.status))
    } else {
      Err(format!(
        "系统截图快捷键唤起失败: {message}。请在 系统设置 > 隐私与安全性 > 辅助功能 中允许 OmniDesk，或直接使用 Control+Command+Shift+4。"
      ))
    }
  }
}

#[tauri::command]
fn pick_screen_color(app: AppHandle, delay_ms: Option<u64>) -> Result<PickedColor, String> {
  if !cfg!(target_os = "macos") {
    return Err("当前仅支持 macOS 屏幕取色".to_string());
  }
  ensure_screen_capture_access()?;

  let delay = delay_ms.unwrap_or(1_200).min(5_000);
  if delay > 0 {
    thread::sleep(Duration::from_millis(delay));
  }

  #[cfg(target_os = "macos")]
  let target = macos_screen::sample_target()?;

  let created_at = now_millis()?;
  let file_name = format!("color-sample-{created_at}.png");
  let path = color_sample_dir(&app)?.join(file_name);

  let status = Command::new("/usr/sbin/screencapture")
    .arg("-x")
    .arg(&path)
    .status()
    .map_err(|err| format!("启动屏幕取色截图失败: {err}"))?;

  if !status.success() {
    return Err(format!("屏幕取色截图失败: {status}"));
  }

  let image = image::ImageReader::open(&path)
    .map_err(|err| format!("读取取色截图失败: {err}"))?
    .decode()
    .map_err(|err| format!("解析取色截图失败: {err}"))?;
  let (width, height) = image.dimensions();
  if width == 0 || height == 0 {
    let _ = fs::remove_file(&path);
    return Err("取色截图为空".to_string());
  }

  #[cfg(target_os = "macos")]
  let (x, y) = {
    let scale_x = if target.bounds_width > 0.0 {
      width as f64 / target.bounds_width
    } else {
      1.0
    };
    let scale_y = if target.bounds_height > 0.0 {
      height as f64 / target.bounds_height
    } else {
      1.0
    };
    let x = ((target.x - target.bounds_x) * scale_x).round() as i32;
    let y = ((target.y - target.bounds_y) * scale_y).round() as i32;
    (
      x.clamp(0, width.saturating_sub(1) as i32),
      y.clamp(0, height.saturating_sub(1) as i32),
    )
  };

  let pixel = image.get_pixel(x as u32, y as u32);
  let [red, green, blue, _alpha] = pixel.0;
  let _ = fs::remove_file(&path);

  Ok(PickedColor {
    hex: format!("#{red:02X}{green:02X}{blue:02X}"),
    rgb: format!("rgb({red}, {green}, {blue})"),
    red,
    green,
    blue,
    x,
    y,
  })
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
  if needle.is_empty() {
    return Some(0);
  }
  haystack.windows(needle.len()).position(|window| window == needle)
}

fn split_route_query(path: &str) -> (&str, &str) {
  path
    .split_once('?')
    .map_or((path, ""), |(route, query)| (route, query))
}

fn query_param(query: &str, key: &str) -> Option<String> {
  query.split('&').find_map(|part| {
    let (part_key, part_value) = part.split_once('=')?;
    if part_key == key {
      Some(part_value.to_string())
    } else {
      None
    }
  })
}

struct LocalDropRequest {
  method: String,
  route: String,
  token: Option<String>,
  headers: Vec<(String, String)>,
  body: Vec<u8>,
}

fn read_local_drop_request(stream: &mut TcpStream) -> Result<LocalDropRequest, String> {
  stream
    .set_read_timeout(Some(Duration::from_secs(10)))
    .map_err(|err| format!("设置快传读取超时失败: {err}"))?;

  let mut buffer = Vec::new();
  let mut chunk = [0_u8; 8192];
  let header_end = loop {
    let count = stream
      .read(&mut chunk)
      .map_err(|err| format!("读取快传请求失败: {err}"))?;
    if count == 0 {
      return Err("快传请求已断开".to_string());
    }
    buffer.extend_from_slice(&chunk[..count]);
    if buffer.len() > 128 * 1024 {
      return Err("快传请求头过大".to_string());
    }
    if let Some(index) = find_bytes(&buffer, b"\r\n\r\n") {
      break index + 4;
    }
  };

  let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
  let mut lines = header_text.split("\r\n").filter(|line| !line.is_empty());
  let request_line = lines.next().ok_or_else(|| "快传请求无效".to_string())?;
  let mut request_parts = request_line.split_whitespace();
  let method = request_parts
    .next()
    .ok_or_else(|| "快传请求方法无效".to_string())?
    .to_string();
  let raw_path = request_parts
    .next()
    .ok_or_else(|| "快传请求路径无效".to_string())?;
  let (route, query) = split_route_query(raw_path);

  let headers = lines
    .filter_map(|line| {
      let (name, value) = line.split_once(':')?;
      Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
    })
    .collect::<Vec<_>>();

  let content_length = headers
    .iter()
    .find(|(name, _)| name == "content-length")
    .and_then(|(_, value)| value.parse::<usize>().ok())
    .unwrap_or(0);
  if content_length > LOCAL_DROP_MAX_UPLOAD_BYTES {
    return Err("上传文件超过 200MB 限制".to_string());
  }

  let mut body = buffer[header_end..].to_vec();
  while body.len() < content_length {
    let count = stream
      .read(&mut chunk)
      .map_err(|err| format!("读取快传文件失败: {err}"))?;
    if count == 0 {
      return Err("快传文件上传中断".to_string());
    }
    body.extend_from_slice(&chunk[..count]);
  }
  body.truncate(content_length);

  Ok(LocalDropRequest {
    method,
    route: route.to_string(),
    token: query_param(query, "token"),
    headers,
    body,
  })
}

fn local_drop_html(token: &str) -> String {
  format!(
    r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OmniDesk Local Drop</title>
  <style>
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    main {{ width: min(420px, calc(100vw - 32px)); padding: 28px; border: 1px solid #dbeafe; border-radius: 22px; background: white; box-shadow: 0 24px 60px rgba(15, 23, 42, .10); }}
    h1 {{ margin: 0 0 8px; font-size: 24px; }}
    p {{ margin: 0 0 22px; color: #64748b; line-height: 1.6; }}
    input {{ width: 100%; box-sizing: border-box; border: 1px dashed #94a3b8; border-radius: 14px; padding: 18px; background: #f8fafc; }}
    button {{ margin-top: 16px; width: 100%; height: 48px; border: 0; border-radius: 14px; background: #10b981; color: white; font-weight: 800; font-size: 16px; }}
  </style>
</head>
<body>
  <main>
    <h1>OmniDesk 快传</h1>
    <p>文件会直接保存到这台电脑的本地收件箱。</p>
    <form method="post" action="/upload?token={token}" enctype="multipart/form-data">
      <input name="file" type="file" multiple required>
      <button type="submit">上传文件</button>
    </form>
  </main>
</body>
</html>"#,
  )
}

fn local_drop_success_html(count: usize) -> String {
  format!(
    r#"<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<main style="width:min(420px,calc(100vw - 32px));padding:28px;border:1px solid #bbf7d0;border-radius:22px;background:white;box-shadow:0 24px 60px rgba(15,23,42,.10)">
<h1 style="margin:0 0 8px;font-size:24px">上传完成</h1>
<p style="margin:0;color:#64748b;line-height:1.6">已保存 {count} 个文件，可以关闭这个页面。</p>
</main></body>"#,
  )
}

fn multipart_boundary(content_type: &str) -> Option<String> {
  content_type.split(';').find_map(|part| {
    let part = part.trim();
    let value = part.strip_prefix("boundary=")?;
    Some(value.trim_matches('"').to_string())
  })
}

fn multipart_filename(headers: &str) -> Option<String> {
  headers.lines().find_map(|line| {
    if !line.to_ascii_lowercase().starts_with("content-disposition:") {
      return None;
    }
    line.split(';').find_map(|part| {
      let value = part.trim().strip_prefix("filename=")?;
      Some(value.trim_matches('"').to_string())
    })
  })
}

fn parse_multipart_files(body: &[u8], boundary: &str) -> Vec<(String, Vec<u8>)> {
  let marker = format!("--{boundary}").into_bytes();
  let mut files = Vec::new();
  let mut cursor = 0;

  while let Some(marker_index) = find_bytes(&body[cursor..], &marker) {
    let after_marker = cursor + marker_index + marker.len();
    if body.get(after_marker..after_marker + 2) == Some(b"--") {
      break;
    }
    let part_start = if body.get(after_marker..after_marker + 2) == Some(b"\r\n") {
      after_marker + 2
    } else {
      after_marker
    };
    let Some(header_separator) = find_bytes(&body[part_start..], b"\r\n\r\n") else {
      break;
    };
    let data_start = part_start + header_separator + 4;
    let Some(next_marker) = find_bytes(&body[data_start..], &marker) else {
      break;
    };
    let mut data_end = data_start + next_marker;
    if data_end >= 2 && &body[data_end - 2..data_end] == b"\r\n" {
      data_end -= 2;
    }

    let headers = String::from_utf8_lossy(&body[part_start..part_start + header_separator]);
    if let Some(file_name) = multipart_filename(&headers) {
      let display_name = safe_display_file_name(&file_name);
      if !display_name.is_empty() && data_end > data_start {
        files.push((display_name, body[data_start..data_end].to_vec()));
      }
    }
    cursor = data_start + next_marker;
  }

  files
}

fn write_http_response(
  stream: &mut TcpStream,
  status_code: u16,
  status_text: &str,
  content_type: &str,
  body: &str,
) -> Result<(), String> {
  let response = format!(
    "HTTP/1.1 {status_code} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
    body.as_bytes().len(),
  );
  stream
    .write_all(response.as_bytes())
    .map_err(|err| format!("写入快传响应失败: {err}"))
}

fn handle_local_drop_upload(req: LocalDropRequest, token: &str, inbox: &PathBuf) -> Result<String, String> {
  if req.token.as_deref() != Some(token) {
    return Err("快传链接已失效".to_string());
  }
  let content_type = req
    .headers
    .iter()
    .find(|(name, _)| name == "content-type")
    .map(|(_, value)| value.as_str())
    .ok_or_else(|| "上传请求缺少 Content-Type".to_string())?;
  let boundary = multipart_boundary(content_type).ok_or_else(|| "上传表单格式无效".to_string())?;
  let files = parse_multipart_files(&req.body, &boundary);
  if files.is_empty() {
    return Err("没有收到文件".to_string());
  }

  for (file_name, bytes) in &files {
    let created_at = now_millis()?;
    let random = general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<4>());
    let target = inbox.join(format!("{created_at}-{random}-{file_name}"));
    fs::write(target, bytes).map_err(|err| format!("保存快传文件失败: {err}"))?;
  }

  Ok(local_drop_success_html(files.len()))
}

fn handle_local_drop_stream(mut stream: TcpStream, token: String, inbox: PathBuf) {
  let response = match read_local_drop_request(&mut stream) {
    Ok(req) if req.method == "GET" && req.route == "/" && req.token.as_deref() == Some(&token) => {
      (200, "OK", local_drop_html(&token))
    }
    Ok(req) if req.method == "POST" && req.route == "/upload" => match handle_local_drop_upload(req, &token, &inbox) {
      Ok(html) => (200, "OK", html),
      Err(message) => (400, "Bad Request", format!("<meta charset=\"utf-8\">{message}")),
    },
    Ok(_) => (404, "Not Found", "<meta charset=\"utf-8\">快传链接无效".to_string()),
    Err(message) => (400, "Bad Request", format!("<meta charset=\"utf-8\">{message}")),
  };

  let _ = write_http_response(
    &mut stream,
    response.0,
    response.1,
    "text/html; charset=utf-8",
    &response.2,
  );
}

fn local_lan_ip() -> String {
  if cfg!(target_os = "macos") {
    for interface in ["en0", "en1", "en2", "bridge100"] {
      if let Ok(output) = Command::new("/usr/sbin/ipconfig")
        .arg("getifaddr")
        .arg(interface)
        .output()
      {
        if output.status.success() {
          let address = String::from_utf8_lossy(&output.stdout).trim().to_string();
          if !address.is_empty() {
            return address;
          }
        }
      }
    }
  }

  UdpSocket::bind("0.0.0.0:0")
    .and_then(|socket| {
      socket.connect("8.8.8.8:80")?;
      socket.local_addr()
    })
    .map(|addr| addr.ip().to_string())
    .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[tauri::command]
fn start_local_drop(app: AppHandle, state: State<AppState>) -> Result<LocalDropInfo, String> {
  let inbox = local_drop_dir(&app)?;
  let listener = TcpListener::bind("0.0.0.0:0").map_err(|err| format!("启动局域网快传失败: {err}"))?;
  listener
    .set_nonblocking(true)
    .map_err(|err| format!("设置快传服务失败: {err}"))?;
  let port = listener
    .local_addr()
    .map_err(|err| format!("读取快传端口失败: {err}"))?
    .port();
  let token = general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<16>());
  let expires_at = now_millis()? + LOCAL_DROP_TTL.as_millis() as u64;
  let info = LocalDropInfo {
    url: format!("http://{}:{port}/?token={token}", local_lan_ip()),
    inbox_path: inbox.to_string_lossy().to_string(),
    token: token.clone(),
    port,
    expires_at,
  };
  let stop = Arc::new(AtomicBool::new(false));

  {
    let mut guard = state
      .inner()
      .as_ref()
      .local_drop
      .lock()
      .map_err(|_| "快传服务状态被占用".to_string())?;
    if let Some(previous) = guard.take() {
      previous.stop.store(true, Ordering::SeqCst);
    }
    *guard = Some(LocalDropServer {
      info: info.clone(),
      stop: stop.clone(),
    });
  }

  thread::spawn(move || {
    while !stop.load(Ordering::SeqCst) {
      if now_millis().map_or(true, |now| now >= expires_at) {
        break;
      }
      match listener.accept() {
        Ok((stream, _addr)) => {
          let token = token.clone();
          let inbox = inbox.clone();
          thread::spawn(move || handle_local_drop_stream(stream, token, inbox));
        }
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
          thread::sleep(Duration::from_millis(120));
        }
        Err(_) => break,
      }
    }
  });

  Ok(info)
}

#[tauri::command]
fn stop_local_drop(state: State<AppState>) -> Result<(), String> {
  let mut guard = state
    .inner()
    .as_ref()
    .local_drop
    .lock()
    .map_err(|_| "快传服务状态被占用".to_string())?;
  if let Some(server) = guard.take() {
    server.stop.store(true, Ordering::SeqCst);
  }
  Ok(())
}

#[tauri::command]
fn local_drop_status(state: State<AppState>) -> Result<Option<LocalDropInfo>, String> {
  let mut guard = state
    .inner()
    .as_ref()
    .local_drop
    .lock()
    .map_err(|_| "快传服务状态被占用".to_string())?;
  if let Some(server) = guard.as_ref() {
    if now_millis()? < server.info.expires_at && !server.stop.load(Ordering::SeqCst) {
      return Ok(Some(server.info.clone()));
    }
  }
  if let Some(server) = guard.take() {
    server.stop.store(true, Ordering::SeqCst);
  }
  Ok(None)
}

#[tauri::command]
fn save_vault_file(
  app: AppHandle,
  state: State<AppState>,
  file_name: String,
  bytes_base64: String,
) -> Result<SavedVaultFile, String> {
  let key = current_key(state.inner().as_ref())?;
  let bytes = general_purpose::STANDARD
    .decode(bytes_base64)
    .map_err(|_| "文件数据不是有效的 Base64".to_string())?;

  if bytes.is_empty() {
    return Err("文件内容为空".to_string());
  }
  if bytes.len() > MAX_VAULT_FILE_BYTES {
    return Err("单个保险箱文件最多 100MB".to_string());
  }

  let created_at = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|err| format!("无法生成保险箱文件记录: {err}"))?
    .as_millis() as u64;
  let random = random_bytes::<8>();
  let id = format!("{created_at}-{}", general_purpose::URL_SAFE_NO_PAD.encode(random));
  let encrypted_file_name = format!("{id}.vault");
  let (nonce, ciphertext) = encrypt_bytes(&key, &bytes)?;
  let payload = EncryptedPayload {
    version: 1,
    nonce,
    ciphertext,
  };
  let payload_bytes = serde_json::to_vec(&payload).map_err(|err| format!("序列化加密文件失败: {err}"))?;
  let path = vault_files_dir(&app)?.join(&encrypted_file_name);
  fs::write(path, payload_bytes).map_err(|err| format!("写入加密文件失败: {err}"))?;

  Ok(SavedVaultFile {
    id,
    file_name: safe_display_file_name(&file_name),
    encrypted_file_name,
    size: bytes.len() as u64,
    created_at,
  })
}

#[tauri::command]
fn export_vault_file(
  app: AppHandle,
  state: State<AppState>,
  encrypted_file_name: String,
  file_name: String,
) -> Result<ExportResult, String> {
  let key = current_key(state.inner().as_ref())?;
  if !is_safe_asset_file_name(&encrypted_file_name) || !encrypted_file_name.ends_with(".vault") {
    return Err("加密文件名无效".to_string());
  }

  let encrypted_path = vault_files_dir(&app)?.join(encrypted_file_name);
  let payload_bytes = fs::read(encrypted_path).map_err(|err| format!("读取加密文件失败: {err}"))?;
  let payload: EncryptedPayload =
    serde_json::from_slice(&payload_bytes).map_err(|err| format!("加密文件格式无效: {err}"))?;
  let plaintext = decrypt_bytes(&key, &payload.nonce, &payload.ciphertext)?;
  export_bytes_to_downloads(&app, &file_name, &plaintext)
}

#[tauri::command]
fn delete_vault_file(app: AppHandle, encrypted_file_name: String) -> Result<(), String> {
  if !is_safe_asset_file_name(&encrypted_file_name) || !encrypted_file_name.ends_with(".vault") {
    return Err("加密文件名无效".to_string());
  }
  let path = vault_files_dir(&app)?.join(encrypted_file_name);
  if path.exists() {
    fs::remove_file(path).map_err(|err| format!("删除加密文件失败: {err}"))?;
  }
  Ok(())
}

#[tauri::command]
fn set_global_shortcuts(
  app: AppHandle,
  shortcuts: Vec<GlobalShortcutConfig>,
) -> Result<(), String> {
  register_global_shortcuts(&app, &shortcuts)?;
  persist_global_shortcuts(&app, &shortcuts)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Arc::new(RuntimeState::default()))
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(target_os = "macos")]
      {
        let shortcuts = load_startup_global_shortcuts(app.handle()).unwrap_or_else(|err| {
          log::warn!("Failed to load persisted global shortcuts: {err}");
          macos_hotkey::default_shortcuts()
        });
        if let Err(err) = register_global_shortcuts(app.handle(), &shortcuts) {
          log::warn!("Global shortcuts are unavailable: {err}");
        }
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      unlock,
      change_master_password,
      verify_password,
      lock_store,
      load_store,
      save_store,
      save_store_item,
      system_idle_millis,
      write_clipboard,
      open_external_url,
      export_json,
      export_workspace_archive,
      import_workspace_archive,
      export_bytes,
      import_json,
      import_chrome_bookmarks,
      search_notes,
      search_bookmarks,
      toggle_quick_panel,
      hide_quick_panel,
      open_main_view,
      capture_screenshot,
      pick_screen_color,
      start_local_drop,
      stop_local_drop,
      local_drop_status,
      save_note_image,
      read_note_image,
      save_vault_file,
      export_vault_file,
      delete_vault_file,
      set_global_shortcuts,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
