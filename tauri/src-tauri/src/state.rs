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
}

pub struct SharedState(pub Mutex<DubMateState>);
