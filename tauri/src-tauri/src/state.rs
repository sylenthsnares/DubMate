use std::sync::Mutex;

#[derive(Default, Debug)]
pub struct DubMateState {
    pub tunnel_url: Option<String>,
    pub room_token: Option<String>,
    pub python_pid: Option<u32>,
    pub cloudflared_pid: Option<u32>,
    pub is_server_ready: bool,
    pub is_tunnel_ready: bool,
}

pub struct SharedState(pub Mutex<DubMateState>);
