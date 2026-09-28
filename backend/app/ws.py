"""WebSocket bağlantı yöneticisi — bağlı tüm web istemcilerine canlı yoğunluk
güncellemesi yayınlamak için (Faz 5, polling'in yerine push)."""

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active:
            self.active.remove(websocket)

    async def broadcast(self, message: dict) -> None:
        dead: list[WebSocket] = []
        for connection in self.active:
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for connection in dead:
            self.disconnect(connection)


# Faz 8.1: tekil global `manager` yerine `mall_id`'ye göre anahtarlanan bir
# sözlük — her AVM'nin canlı yayını sadece KENDİ WebSocket istemcilerine gider.
_managers: dict[int, ConnectionManager] = {}


def manager_for(mall_id: int) -> ConnectionManager:
    return _managers.setdefault(mall_id, ConnectionManager())
