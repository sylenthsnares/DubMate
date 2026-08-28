export interface RoomEntry {
  tunnel_url: string;    // Full https://xxxx.trycloudflare.com URL
  room_token: string;    // 32-char hex secret — only the host ever sees this
  created_at: number;    // Unix timestamp (seconds)
  app_version: string;   // e.g. "1.0.0" — used by clients to detect mismatches
}

export interface CreateRoomRequest {
  tunnel_url: string;
  app_version?: string;
}

export interface UpdateRoomRequest {
  tunnel_url: string;
  app_version?: string;
}

export interface CreateRoomResponse {
  code: string;
  room_token: string;
}

export interface UpdateRoomResponse {
  ok: boolean;
  message?: string;
}
