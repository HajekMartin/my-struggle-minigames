export interface Player { id: string; name: string }
export interface LobbyPlayer extends Player { ready: boolean; connected: boolean }
export interface LobbyState { code: string; started: boolean; players: LobbyPlayer[] }
