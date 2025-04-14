#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::Emitter;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::{routing::post, Extension, Router, response::IntoResponse};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use futures::stream::{SplitSink, StreamExt};
use futures::SinkExt;
use tokio::sync::Mutex as TokioMutex;

mod chess;
mod db;
mod error;
mod fide;
mod fs;
mod lexer;
mod oauth;
mod opening;
mod pgn;
mod puzzle;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::{fs::create_dir_all, path::Path};

use chess::{BestMovesPayload, EngineProcess, ReportProgress};
use dashmap::DashMap;
use db::{DatabaseProgress, GameQueryJs, NormalizedGame, PositionStats};
use derivative::Derivative;
use fide::FidePlayer;
use log::LevelFilter;
use oauth::AuthState;
use specta_typescript::{BigIntExportBehavior, Typescript};
use sysinfo::SystemExt;
use tauri::path::BaseDirectory;
use tauri::{Manager, Window, AppHandle};
use tauri_plugin_log::{Target, TargetKind};
use std::net::SocketAddr;

use crate::chess::{
    analyze_game, get_engine_config, get_engine_logs, kill_engine, kill_engines, stop_engine,
};
use crate::db::{
    clear_games, convert_pgn, create_indexes, delete_database, delete_db_game, delete_empty_games,
    delete_indexes, export_to_pgn, get_player, get_players_game_info, get_tournaments,
    search_position,
};
use crate::fide::{download_fide_db, find_fide_player};
use crate::fs::{set_file_as_executable, DownloadProgress};
use crate::lexer::lex_pgn;
use crate::oauth::authenticate;
use crate::pgn::{count_pgn_games, delete_game, read_games, write_game};
use crate::puzzle::{get_puzzle, get_puzzle_db_info};
use crate::{
    chess::get_best_moves,
    db::{
        delete_duplicated_games, edit_db_info, get_db_info, get_games, get_players, merge_players,
    },
    fs::{download_file, file_exists, get_file_metadata},
    opening::{get_opening_from_fen, get_opening_from_name, search_opening_name},
};
use tokio::sync::{RwLock, Semaphore};

// Define a type for the shared client state
// Using TokioMutex for async locking and HashMap to store client senders
// Key: Unique client ID, Value: Sender part of the WebSocket
type Clients = Arc<TokioMutex<HashMap<usize, SplitSink<WebSocket, Message>>>>;

// Unique ID generator for clients
static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

pub type GameData = (
    i32,
    i32,
    i32,
    Option<String>,
    Option<String>,
    Vec<u8>,
    Option<String>,
    i32,
    i32,
    i32,
);

#[derive(Derivative)]
#[derivative(Default)]
pub struct AppState {
    connection_pool: DashMap<
        String,
        diesel::r2d2::Pool<diesel::r2d2::ConnectionManager<diesel::SqliteConnection>>,
    >,
    line_cache: DashMap<(GameQueryJs, PathBuf), (Vec<PositionStats>, Vec<NormalizedGame>)>,
    db_cache: Mutex<Vec<GameData>>,
    #[derivative(Default(value = "Arc::new(Semaphore::new(2))"))]
    new_request: Arc<Semaphore>,
    pgn_offsets: DashMap<String, Vec<u64>>,
    fide_players: RwLock<Vec<FidePlayer>>,
    engine_processes: DashMap<(String, String), Arc<tokio::sync::Mutex<EngineProcess>>>,
    auth: AuthState,
}

const REQUIRED_DIRS: &[(BaseDirectory, &str)] = &[
    (BaseDirectory::AppData, "engines"),
    (BaseDirectory::AppData, "db"),
    (BaseDirectory::AppData, "presets"),
    (BaseDirectory::AppData, "puzzles"),
    (BaseDirectory::AppData, "documents"),
    (BaseDirectory::Document, "EnCroissant"),
];

const REQUIRED_FILES: &[(BaseDirectory, &str, &str)] =
    &[(BaseDirectory::AppData, "engines/engines.json", "[]")];

#[tauri::command]
#[specta::specta]
async fn close_splashscreen(window: Window) -> Result<(), String> {
    window
        .get_webview_window("main")
        .expect("no window labeled 'main' found")
        .show()
        .unwrap();
    Ok(())
}

// Handler for the FEN POST request
async fn handle_fen(Extension(app_handle): Extension<AppHandle>, fen: String) {
    log::info!("[FEN Sync] Received FEN: {}", fen);
    // Emit the FEN update event to the frontend
    if let Err(e) = app_handle.emit("fen-update", &fen) { // Pass fen by reference
        log::error!("[FEN Sync] Failed to emit fen-update event: {}", e);
    }
}

// WebSocket handler for real-time communication
async fn websocket_handler(
    ws: WebSocketUpgrade, 
    Extension(app_handle): Extension<AppHandle>,
    Extension(clients): Extension<Clients> // Accept shared state
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, app_handle, clients)) // Pass state to handle_socket
}

async fn handle_socket(socket: WebSocket, app_handle: AppHandle, clients: Clients) {
    // Generate a unique ID for this client
    let my_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    log::info!("[WebSocket] Client connected: {}", my_id);

    // Split the socket into a sender and receiver
    let (mut sender, mut receiver) = socket.split();

    // Send the connected status message using format!
    let welcome_msg = format!("{{\"status\":\"connected\", \"id\": {}}}", my_id);
    if sender.send(Message::Text(welcome_msg)).await.is_err() {
        log::error!("[WebSocket] Client {} failed to send welcome message", my_id);
        return; // Can't send, might as well stop
    }

    // Add the sender to the shared state
    clients.lock().await.insert(my_id, sender);

    // Main message loop
    while let Some(result) = receiver.next().await {
        match result {
            Ok(msg) => {
                // Process the received message
                process_message(msg, my_id, &app_handle, &clients).await;
            }
            Err(e) => {
                log::error!("[WebSocket] Error receiving message from client {}: {}", my_id, e);
                break; // Error, stop processing for this client
            }
        }
    }

    // Client disconnected or errored out, remove from state
    log::info!("[WebSocket] Client {} disconnected", my_id);
    clients.lock().await.remove(&my_id);
}

// Separate function to process messages for clarity
async fn process_message(msg: Message, my_id: usize, app_handle: &AppHandle, clients: &Clients) {
    match msg {
        Message::Text(text) => {
            log::info!("[WebSocket] Client {} sent text message", my_id);

            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(json_data) => {
                    if json_data.get("engineId").and_then(|v| v.as_str()) == Some("board_visualization") {
                        log::info!("[WebSocket] Received analysis message from client {}: {}", my_id, text);

                        // --- BROADCAST LOGIC --- 
                        let mut clients_map = clients.lock().await;
                        for (&id, sender) in clients_map.iter_mut() {
                            if id != my_id { // Don't send back to original sender
                                if sender.send(Message::Text(text.clone())).await.is_err() {
                                    log::warn!("[WebSocket] Failed to send analysis to client {}, removing.", id);
                                    // Error sending, likely disconnected - schedule for removal? (Map removal during iteration is tricky)
                                }
                            }
                        }
                        // --- END BROADCAST --- 

                        // Send confirmation back to the original sender
                        if let Some(sender) = clients_map.get_mut(&my_id) {
                           let confirmation = r#"{"status":"received"}"#;
                           if sender.send(Message::Text(confirmation.to_string())).await.is_err() {
                               log::warn!("[WebSocket] Failed to send confirmation to client {}", my_id);
                           }
                        }

                    } else if json_data.get("fen").is_some() {
                       log::info!("[WebSocket] Received FEN from client {}: {}", my_id, text);
                       // If FEN needs broadcasting, add similar logic here
                       // Emit to Tauri frontend if needed
                        if let Err(e) = app_handle.emit("fen-update", &text) {
                           log::error!("[WebSocket] Failed to emit fen-update from WS: {}", e);
                        }

                    } else {
                        log::warn!("[WebSocket] Client {} sent unknown JSON structure: {}", my_id, text);
                        // Optional: Send error back to sender
                        if let Some(sender) = clients.lock().await.get_mut(&my_id) {
                           let error_msg = r#"{"status":"error","message":"Unknown message format"}"#;
                           let _ = sender.send(Message::Text(error_msg.to_string())).await;
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[WebSocket] Client {} sent invalid JSON: {}. Error: {}", my_id, text, e);
                    // Optional: Send error back to sender
                     if let Some(sender) = clients.lock().await.get_mut(&my_id) {
                        let error_msg = r#"{"status":"error","message":"Invalid JSON"}"#;
                        let _ = sender.send(Message::Text(error_msg.to_string())).await;
                     }
                }
            }
        }
        Message::Binary(_) => {
            log::info!("[WebSocket] Client {} sent binary message (unsupported)", my_id);
            // Optional: Send error back to sender
             if let Some(sender) = clients.lock().await.get_mut(&my_id) {
                let error_msg = r#"{"status":"error","message":"Binary messages not supported"}"#;
                let _ = sender.send(Message::Text(error_msg.to_string())).await;
             }
        }
        Message::Ping(data) => {
             log::info!("[WebSocket] Client {} sent ping", my_id);
             if let Some(sender) = clients.lock().await.get_mut(&my_id) {
                if sender.send(Message::Pong(data)).await.is_err() {
                   log::error!("[WebSocket] Failed to send pong to client {}", my_id);
                   // Consider this an error indicating client issues
                }
             }
        }
        Message::Pong(_) => {
            // Pong received, client is alive - ignore
        }
        Message::Close(_) => {
            // Close message handled by the main loop dropping the receiver stream
            log::info!("[WebSocket] Received close frame from client {}", my_id);
        }
    }
}

fn main() {
    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands!(
            close_splashscreen,
            find_fide_player,
            get_best_moves,
            analyze_game,
            stop_engine,
            kill_engine,
            kill_engines,
            get_engine_logs,
            memory_size,
            get_puzzle,
            search_opening_name,
            get_opening_from_fen,
            get_opening_from_name,
            get_players_game_info,
            get_engine_config,
            file_exists,
            get_file_metadata,
            merge_players,
            convert_pgn,
            get_player,
            count_pgn_games,
            read_games,
            lex_pgn,
            is_bmi2_compatible,
            delete_game,
            delete_duplicated_games,
            delete_empty_games,
            clear_games,
            set_file_as_executable,
            delete_indexes,
            create_indexes,
            edit_db_info,
            delete_db_game,
            delete_database,
            export_to_pgn,
            authenticate,
            write_game,
            download_fide_db,
            download_file,
            get_tournaments,
            get_db_info,
            get_games,
            search_position,
            get_players,
            get_puzzle_db_info
        ))
        .events(tauri_specta::collect_events!(
            BestMovesPayload,
            DatabaseProgress,
            DownloadProgress,
            ReportProgress
        ));

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::BigInt),
            "../src/bindings/generated.ts",
        )
        .expect("Failed to export types");

    #[cfg(debug_assertions)]
    let log_targets = [TargetKind::Stdout, TargetKind::Webview];

    #[cfg(not(debug_assertions))]
    let log_targets = [
        TargetKind::Stdout,
        TargetKind::LogDir {
            file_name: Some(String::from("en-croissant.log")),
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets(log_targets.map(Target::new))
                .level(LevelFilter::Info)
                .build(),
        )
        .invoke_handler(specta_builder.invoke_handler())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(move |app| {
            log::info!("Setting up application");
            let app_handle = app.handle().clone(); // Clone AppHandle for async tasks

            // --- Initialize WebSocket Shared State ---
            let clients_state: Clients = Arc::new(TokioMutex::new(HashMap::new()));

            // --- Start FEN Sync Server --- 
            tauri::async_runtime::spawn(async move {
                let fen_sync_router = Router::new()
                    .route("/fen", post(handle_fen))
                    .route("/ws", axum::routing::get(websocket_handler)) // Use axum's built-in WebSocket handler
                    .layer(Extension(app_handle.clone())) // Provide cloned AppHandle
                    .layer(Extension(clients_state.clone())); // Provide shared client state

                let addr_str = "127.0.0.1:3030";
                let addr: SocketAddr = match addr_str.parse() {
                    Ok(addr) => addr,
                    Err(e) => {
                        log::error!("[FEN Sync] Failed to parse address '{}': {}", addr_str, e);
                        return;
                    }
                };

                log::info!("[FEN Sync] Starting server on {}", addr);
                if let Err(e) = axum::Server::bind(&addr)
                    .serve(fen_sync_router.into_make_service())
                    .await
                {
                    log::error!("[FEN Sync] Server failed to start: {}", e);
                }
            });
            // --- End FEN Sync Server ---

            log::info!("Checking for required directories");
            for (dir, path) in REQUIRED_DIRS.iter() {
                let path = app.path().resolve(path, *dir);
                if let Ok(path) = path {
                    if !Path::new(&path).exists() {
                        log::info!("Creating directory {}", path.to_string_lossy());
                        create_dir_all(&path).unwrap();
                    }
                };
            }

            log::info!("Checking for required files");
            for (dir, path, contents) in REQUIRED_FILES.iter() {
                let path = app.path().resolve(path, *dir).unwrap();
                if !Path::new(&path).exists() {
                    log::info!("Creating file {}", path.to_string_lossy());
                    std::fs::write(&path, contents).unwrap();
                }
            }

            // #[cfg(any(windows, target_os = "macos"))]
            // set_shadow(&app.get_webview_window("main").unwrap(), true).unwrap();

            specta_builder.mount_events(app);

            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_cli::init())?;

            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            log::info!("Finished rust initialization");

            Ok(())
        })
        .manage(AppState::default())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
#[specta::specta]
fn is_bmi2_compatible() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("bmi2") {
        return true;
    }
    false
}

#[tauri::command]
#[specta::specta]
fn memory_size() -> u32 {
    let total_bytes = sysinfo::System::new_all().total_memory();
    (total_bytes / 1024 / 1024) as u32
}
