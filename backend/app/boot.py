"""Bu backend sürecinin kimliği — her başlangıçta (her reset'te) değişir.
Web istemcisi bunu `/health` ve her WebSocket mesajında görür; değiştiğini
fark edince eski haftaya ait bildirimleri temizler (bkz. apps/web
`notifications-context.tsx`)."""

import uuid

BOOT_ID = str(uuid.uuid4())
