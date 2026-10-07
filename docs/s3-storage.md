# S3-хранилище (Wave 5): профиль, presigned URLs, эксплуатация

## Зачем

`FILE_STORAGE=local` держит файлы на диске контейнера (`uploads_data` volume) —
горизонтальное масштабирование file-server невозможно (реплики не видят файлы
друг друга) и бэкапы отдельны от БД. S3-профиль переносит хранение в объектный
бакет: общий бакет для всех реплик, presigned URLs для прямого трафика
клиент↔бакет, стандартные инструменты бэкапа/репликации.

## Бэкенд: SeaweedFS (дефолт), MinIO — не рекомендуется

Дефолт профиля — **SeaweedFS** (`chrislusf/seaweedfs`, Apache 2.0, живой
проект). MinIO больше **не** дефолт: в сентябре 2025 MinIO удалил свои образы
с Docker Hub (`minio/minio`, `minio/mc` — репозитории снесены), а
open-source-редакция заморожена с апреля 2025 (репозиторий заархивирован,
security-патчей не будет); quay.io отдаёт образы только после логина. Если в
частном registry MinIO уже есть — сервис `s3` в профиле заменяется на него
1-в-1 (см. ниже), file-server говорит на обычном S3 и разницы не видит.

Специфика SeaweedFS, обнаруженная на стенде: SigV4-верификация SeaweedFS 3.80
отвергает presigned URL с параметром `x-amz-checksum-mode` (SDK v3 по умолчанию
его добавляет). file-server ≥0.7.3 отключает checksum-параметры на presign-клиенте
(`requestChecksumCalculation`/`responseChecksumValidation: WHEN_REQUIRED`) —
регресс-тест в `presign.spec.ts`. Версии SeaweedFS новее 3.80 не проверялись.

## Включение

```bash
# .env: S3_BUCKET=files, S3_ACCESS_KEY_ID=..., S3_SECRET_ACCESS_KEY=...
docker compose -f docker-compose.yml -f docker-compose.s3.yml up -d
```

Профиль добавляет: сервис `s3` (backend network, published `127.0.0.1:9000`
только для dev; S3-auth генерируется из `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`),
одноразовый `bucket-init` (идемпотентное создание бакета с retry — S3-порт
SeaweedFS отвечает раньше готовности filer'а; бакет приватный по умолчанию)
и переопределяет `file-server`: `FILE_STORAGE=s3`, S3-окружение, `volumes: []`
(uploads_data больше не маунтится).

Проверка: `curl http://<gateway>/health/storage` →
`{"status":"ok","storage":"s3"}` (в nginx проба заведена на file-server,
`location = /health/storage` — годится для LB).

## Топология трафика

| Путь | Канал | Лимит размера |
|------|-------|---------------|
| `POST /files/upload` (прокси) | клиент → nginx → file-server → s3 | nginx `client_max_body_size` + `MAX_UPLOAD_SIZE` (multer, 413) |
| presigned PUT (прямой) | клиент → `S3_PRESIGN_ENDPOINT` (мимо nginx) | потолок бакета; nginx не участвует |
| presigned GET (прямой) | клиент ← `S3_PRESIGN_ENDPOINT` | — |
| служебный (get/head/delete) | file-server → `S3_ENDPOINT` (`http://s3:9000`) | — |

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
    proxy_pass http://s3:9000;         # Host passthrough (дефолт proxy_pass)
    proxy_set_header Host $host;       # ОБЯЗАТЕЛЬНО: подпись покрывает Host
    proxy_request_buffering off;       # стриминг больших PUT
  }
}
```

`S3_PRESIGN_ENDPOINT=https://s3.example.com` в `.env`. Путь-rewrite
(`/s3/...` location) ломает canonical path SigV4 — не использовать; только
subdomain или прямой порт.

## CDN / публичный бакет

Два переключателя (opt-in, дефолт — приватный бакет + presigned GET):

- `S3_PUBLIC_BUCKET=true` — композ добавляет в генерируемый `s3.json`
  credential-less identity `anonymous` с `Read:<bucket>` (SeaweedFS-нативный
  способ анонимного чтения). Для MinIO — `mc anonymous set download`.
- `S3_PUBLIC_URL=https://cdn.example.com` (dev: `http://127.0.0.1:9000/<bucket>`)
  — save.handler отдаёт для **публичных по ACL-правилам** ключей абсолютные URL
  на эту базу, мимо file-server. Приватные ключи продолжают ходить через
  прокси `/uploads` (since file-server 0.8.1, пинено тестами: CDN-ссылка без
  публичного правила не выдаётся).

Осознанный компромисс: анонимное чтение бакета — это «правда о публичности»
на уровне бакета, а ACL-правила file-server остаются источником для URL в API.
Верификация волны 13 (живой стенд): публичная папка → URL на S3_PUBLIC_URL,
прямой GET мимо стека 200; приватный ключ → `/uploads/...`, аноним 404,
bearer 200; presigned PUT/GET работают; `--scale file-server=2` — upload через
одну реплику, скачивание round-robin с обеих (общий бакет снимает
однорепличность local-режима).

## Ограничения presigned PUT (известные, задокументированы)

- Content-Type не пинится в подпись: `@aws-sdk/s3-request-presigner` жёстко
  добавляет его в unsignable. Клиент шлёт свой Content-Type, бакет сохраняет
  присланный; защита при скачивании — attachment-диспозиция.
- Presigned POST policy (`content-length-range`) AWS SDK v3 не поддерживает —
  ограничение размера на прямом пути только политикой бакета.

## Замена бэкенда (MinIO из частного registry / другой S3)

Сервис `s3` в `docker-compose.s3.yml` — единственная точка замены. Для MinIO:

```yaml
  s3:
    image: <registry>/minio/minio:RELEASE.2025-09-07T16-13-09Z
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=${S3_ACCESS_KEY_ID}
      - MINIO_ROOT_PASSWORD=${S3_SECRET_ACCESS_KEY}
```

`bucket-init` (amazon/aws-cli) и file-server не меняются. Пинуйте конкретный
тег: у MinIO `latest` больше не существует на публичных registry.

## Миграция local → s3

`node file-server/scripts/migrate-to-s3.mjs` (dry-run по умолчанию, `--apply`,
`--delete-local`) переносит содержимое `uploads_data` в бакет с теми же
ключами — object key совпадает с путём в `/uploads`, URL в БД не ломаются.
Идемпотентен (существующие объекты пропускаются) — прерванный запуск
повторяется. Порядок: миграция `--apply` → переключение `FILE_STORAGE=s3` →
rolling restart; `--delete-local` только после проверки download'ов. Скрипт —
host-side утилита; для volume-стендов удобнее запускать в контейнере с
маунтами volume и исходников:

```bash
docker run --rm --network gateway-server_backend \
  -v gateway-server_uploads_data:/data:ro \
  -v <repo>/file-server:/app:ro -w /app \
  -e UPLOADS_PATH=/data -e S3_BUCKET=… -e S3_ENDPOINT=http://s3:9000 \
  -e S3_FORCE_PATH_STYLE=true -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… \
  node:22-alpine node scripts/migrate-to-s3.mjs --apply
```

## HA и эксплуатация

- file-server ×2: работает из коробки — состояние в бакете и БД, реплики
  stateless. SeaweedFS в профиле — single-node; для SLA — cluster mode
  (master+volume+filer на нескольких узлах) или managed S3.
- Бэкап: `aws s3 sync s3://files …` (aws-cli) + существующий `backup.sh` для
  БД. Uploads больше не в `uploads_data` — исключите volume из старых
  бэкап-скриптов.
- Ротация S3-ключей: новые ключи в `.env` → `docker compose ... up -d s3
  file-server` (file-server перечитает env; у SeaweedFS ключи — это
  s3.config, пересоздаётся при старте контейнера).
- `GET /health/storage` — проба хранилища (S3: HeadBucket); boot-check пишет
  недоступный бакет в лог ошибкой, не крешит.
