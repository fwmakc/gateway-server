# S3-хранилище (Wave 5): MinIO-профиль, presigned URLs, эксплуатация

## Зачем

`FILE_STORAGE=local` держит файлы на диске контейнера (`uploads_data` volume) —
горизонтальное масштабирование file-server невозможно (реплики не видят файлы
друг друга) и бэкапы отдельны от БД. S3-профиль переносит хранение в MinIO
(де-факто стандарт self-hosted S3; SeaweedFS — Apache-2.0 drop-in, см. ниже):
общий бакет для всех реплик, presigned URLs для прямого трафика клиент↔бакет,
стандартные инструменты бэкапа/репликации.

## Включение

```bash
# .env: S3_BUCKET=files, S3_ACCESS_KEY_ID=..., S3_SECRET_ACCESS_KEY=...
docker compose -f docker-compose.yml -f docker-compose.s3.yml up -d
```

Профиль добавляет: `minio` (backend network, published `127.0.0.1:9000` только
для dev), одноразовый `bucket-init` (идемпотентное создание бакета, приватный
по умолчанию) и переопределяет `file-server`: `FILE_STORAGE=s3`, S3-окружение,
`volumes: []` (uploads_data больше не маунтится).

Проверка: `curl http://localhost:3002/health/storage` →
`{"status":"ok","storage":"s3"}`.

## Топология трафика

| Путь | Канал | Лимит размера |
|------|-------|---------------|
| `POST /files/upload` (прокси) | клиент → nginx → file-server → minio | nginx `client_max_body_size` + `MAX_UPLOAD_SIZE` (multer, 413) |
| presigned PUT (прямой) | клиент → `S3_PRESIGN_ENDPOINT` (мимо nginx) | потолок бакета; nginx не участвует |
| presigned GET (прямой) | клиент ← `S3_PRESIGN_ENDPOINT` | — |
| служебный (get/delete/head) | file-server → `S3_ENDPOINT` (`http://minio:9000`) | — |

Presigned-маршруты: `POST /files/presign/upload` `{filename, folder?}` →
`{url, key, expiresIn}`; `POST /files/presign/download` `{key}` → `{url,
expiresIn}` (404, если объекта нет). Оба требуют JWT (`@Account`). Ключ
генерирует сервер (`folder/<uuid>-<sanitized-name>`) — клиент не выбирает ключ,
перезапись чужих объектов и перебор имён невозможны. Presigned GET всегда
подписан с `ResponseContentDisposition: attachment` — загруженный
пользователем контент не исполняется в origin-контексте бакета.

## Prod: публикация бакета (subdomain-паттерн)

SigV4 подписывает заголовок Host, поэтому presigned URL обязан указывать на
тот endpoint, куда реально стучится клиент. Рабочая схема — поддомен с
прозрачным проксированием:

```nginx
server {
  server_name s3.example.com;
  client_max_body_size 0;              # прямой трафик, nginx не режет
  location / {
    proxy_pass http://minio:9000;      # Host passthrough (дефолт proxy_pass)
    proxy_set_header Host $host;       # ОБЯЗАТЕЛЬНО: подпись покрывает Host
    proxy_request_buffering off;       # стриминг больших PUT
  }
}
```

`S3_PRESIGN_ENDPOINT=https://s3.example.com` в `.env`. Путь-rewrite
(`MINIO_SERVER_URL` с префиксом пути, `/s3/...` location) ломает canonical
path SigV4 — не использовать; только subdomain или прямой порт.

## CDN / публичный бакет

`S3_PUBLIC_URL=https://cdn.example.com` — save.handler отдаёт в ответах
абсолютные URL мимо file-server. Бакет при этом должен быть читаемым анонимно
(`mc anonymous set download local/$S3_BUCKET`) — это осознанный компромисс
публичной раздачи; дефолт профиля — приватный бакет + presigned GET.

## Ограничения presigned PUT (известные, задокументированы)

- Content-Type не пинится в подпись: `@aws-sdk/s3-request-presigner` жёстко
  добавляет его в unsignable. Клиент шлёт свой Content-Type, бакет сохраняет
  присланный; защита при скачивании — attachment-диспозиция.
- Presigned POST policy (`content-length-range`) AWS SDK v3 не поддерживает —
  ограничение размера на прямом пути только политикой бакета.

## SeaweedFS вместо MinIO

Тот же S3-интерфейс, лицензия Apache 2.0 (MinIO — AGPLv3). В
`docker-compose.s3.yml` заменить сервис `minio`:

```yaml
  minio:
    image: chrislusf/seaweedfs:3.80
    command: server -dir=/data -s3 -s3.port=9000
    # env/порты/volumes — аналогично; S3-ключи задаются его ways или IAM
```

file-server и bucket-init не меняются (обычный S3 + force-path-style).

## Миграция local → s3

`node file-server/scripts/migrate-to-s3.mjs` (dry-run по умолчанию, `--apply`,
`--delete-local`) переносит содержимое `uploads_data` в бакет с теми же
ключами — object key совпадает с путём в `/uploads`, URL в БД не ломаются.
Порядок: миграция → переключение `FILE_STORAGE=s3` → rolling restart. Детали:
`node scripts/migrate-to-s3.mjs --help`.

## HA и эксплуатация

- file-server ×2: работает из коробки — состояние в бакете и БД, реплики
  stateless. MinIO — single-node в профиле; для SLA — distributed MinIO
  (4+ узла, erasure coding) или managed S3.
- Бэкап: `mc mirror` бакета + существующий `backup.sh` для БД. Uploads больше
  не в `uploads_data` — исключите volume из старых бэкап-скриптов.
- Ротация S3-ключей: новые ключи в `.env` → `docker compose ... up -d minio
  file-server` (MinIO валидирует старые сессии; file-server перечитает env).
- `GET /health/storage` — проба хранилища (HeadBucket); boot-check пишет
  недоступный бакет в лог ошибкой, не креша.
