use std::sync::Mutex;

#[derive(Default, Debug)]
pub struct DubMateState {
    pub python_pid: Option<u32>,
    pub cloudflared_pid: Option<u32>,
    /// Executable names recorded at spawn time. Windows recycles PIDs, so these
    /// are used to confirm a PID still refers to our own process before killing it.
    pub python_image: Option<String>,
    pub cloudflared_image: Option<String>,
    /// Port the Python engine actually bound to; 8000 unless it was taken.
    pub engine_port: Option<u16>,
    pub is_tunnel_ready: bool,
    /// The last `server-error`, until the next start. A failure in the first moments
    /// can come before the launcher listens, so it asks for this once it does.
    pub last_failure: Option<crate::sidecars::EngineFailure>,
    /// The one-time move out of a 1.x install folder, for `get_file_move`: it starts
    /// from setup, usually before the launcher listens for `moving-files`.
    pub file_move: FileMove,
    /// The Python running that move, so closing the window stops it too.
    pub move_pid: Option<(u32, Option<String>)>,
}

#[derive(Default, Debug, Clone, Copy, serde::Serialize)]
pub struct FileMove {
    /// Files are being moved now.
    pub moving: bool,
    /// The last move left something in the old folder (it still works there).
    pub failed: bool,
}

pub struct SharedState(pub Mutex<DubMateState>);
