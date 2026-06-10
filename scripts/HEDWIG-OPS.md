# Hedwig デプロイ運用メモ

Fly.io 東京リージョン (nrt) 上の OpenClaw ゲートウェイ `sableshedwig` のデプロイ・運用ノート。

## デプロイ方法（何が動いて何が動かないか）

### ✅ 推奨: GitHub Actions ビルド + fly deploy --image

`hedwig` ブランチへ push すると `.github/workflows/build-hedwig-image.yml` が
GitHub ランナー上でフルイメージをビルドし、Fly レジストリへ直接 push する。
Fly リモートビルダー（push 切断問題）もローカル Docker（OOM）も使わない。

```sh
git push fork hedwig                  # → CI がイメージをビルド & push（~15分）
gh run watch --repo sablehead/openclaw  # ビルド完了を待つ

# デプロイ（ビルドはせず、push 済みイメージを使うだけなので軽い）
fly deploy --app sableshedwig --image registry.fly.io/sableshedwig:hedwig-latest
```

- SHA 付きタグ `hedwig-<full-sha>` も push されるので、ロールバックはその SHA を指定する
- 必要シークレット: fork リポジトリの `FLY_API_TOKEN`（`fly tokens create deploy -a sableshedwig` で発行）
- 手動実行: `gh workflow run build-hedwig-image.yml --repo sablehead/openclaw --ref hedwig`
  （`deploy=true` 入力で CI からそのままデプロイも可能）

### ✅ 動く: fly ssh sftp + machine restart

fly-start.sh やワークスペースファイルだけの変更はこれで十分。数秒で完了。

```sh
# 1. 既存ファイルを削除（sftp は上書き不可）
fly ssh console -C "rm /app/fly-start.sh"

# 2. アップロード
fly ssh sftp shell <<'EOF'
put scripts/fly-start.sh /app/fly-start.sh
EOF

# 3. 実行権限付与
fly ssh console -C "chmod +x /app/fly-start.sh"

# 4. 再起動
fly machine restart 1854407b453318
```

### ✅ 動く: himalaya バイナリの GHCR キャッシュ

himalaya は OAuth2 cargo feature 付きで Rust ソースビルドが必要（~7分）。
毎回ビルドするのは無駄なので、GitHub Actions でビルドして GHCR に push 済み。

- イメージ: `ghcr.io/sablehead/himalaya-oauth2:latest`
- 再ビルド: `gh workflow run build-himalaya.yml --repo sablehead/openclaw --ref build-himalaya`
- Dockerfile では `COPY --from=ghcr.io/sablehead/himalaya-oauth2:latest /himalaya /usr/local/bin/himalaya`

※ workflow_dispatch は GitHub のデフォルトブランチにファイルがないと 404 になる。
`build-himalaya` ブランチを一時的にデフォルトに切り替えて実行した。

```sh
gh api repos/sablehead/openclaw -X PATCH -f default_branch=build-himalaya
gh workflow run build-himalaya.yml --repo sablehead/openclaw --ref build-himalaya
gh api repos/sablehead/openclaw -X PATCH -f default_branch=main  # 戻す
```

### ❌ 失敗する: fly deploy --remote-only（レジストリ push 段階）

**症状**: ビルド自体は成功し、ほぼ全レイヤーが push されるが、最後の 1-2 レイヤーで
接続が切れてリトライ → 最終的に以下のエラーで失敗:

```
Error: failed to fetch an image or build from source:
  failed to parse daemon host "unix:///var/run/docker.sock": missing hostname
```

**原因分析**:

- flyctl v0.4.58 の既知の挙動。リモートビルダーの接続が切れた後、
  ローカルの Docker Desktop ソケットにフォールバックしようとしてパースエラー。
- `DOCKER_HOST=""` で回避を試みたが同じ結果。
- ローカル Docker Desktop が起動中でも未起動でも関係なく発生。
- nrt リージョンのビルダーで再現性が高い（2026-06-09 時点）。

**試した対策と結果**:
| 方法 | 結果 |
|------|------|
| `fly deploy --remote-only --depot=false` | ❌ レイヤー push で切断 |
| `fly deploy --remote-only --depot=false --recreate-builder` | ❌ 同上 |
| `DOCKER_HOST="" fly deploy --remote-only --depot=false` | ❌ 同上 |
| `fly deploy --local-only` | ❌ Docker Desktop が応答しない/OOM |
| ビルダー RAM 8GB → 16GB | ビルド OOM は解消したが push 問題は残る |

### ❌ 失敗する: fly deploy --local-only

**症状**: Docker Desktop が応答しない（`docker ps` がハングする）。
仮に Docker が動いていても、tsdown + himalaya の同時ビルドで OOM (SIGKILL) になる。

**原因**: Mac の Docker Desktop の不安定さ + メモリ不足。

### ❌ 失敗する: nrt リージョンでビルダー作成

```
Error: failed to create volume: no capacity available in nrt
```

nrt のボリューム容量が枯渇している時期がある（2026-06-09 確認）。
`--recreate-builder` でも同じリージョンに作られるので回避不可。

## ビルダーの RAM

新しいビルダーはデフォルト 8GB。tsdown が OOM で死ぬので 16GB に上げる必要がある。

```sh
# ビルダーアプリ名を確認
fly apps list | grep build

# マシン ID を確認
fly machines list --app fly-builder-glimmering-field-1893

# 16GB に変更
fly machine update <MACHINE_ID> --app <BUILDER_APP> --vm-memory 16384 --yes
```

## himalaya 設定

### 永続 config 優先

`/data/himalaya-config.toml` が存在すればそれを使い、なければ env vars から生成する。
fly-start.sh の該当ロジック:

```sh
if [ -f /data/himalaya-config.toml ]; then
  cp /data/himalaya-config.toml /home/node/.config/himalaya/config.toml
elif [ -n "$GOOGLE_GMAIL_REFRESH_TOKEN" ]; then
  # env vars から v1.2.0 フォーマットで生成
fi
```

config を変更したい場合は SSH で直接 `/data/himalaya-config.toml` を編集して再起動。

### v1.2.0 フォーマット注意点

- テーブル `[accounts.Gmail.backend]` ではなくドット記法 `backend.type = "imap"`
- `message-writer` → `message.send.backend`
- secret は `.raw` サブキーが必須（`client-secret.raw`, `refresh-token.raw`, `access-token.raw`）
- `login` フィールドが必要
- `method = "xoauth2"`, `pkce = false`, `auth-url` が必要
- Gmail 送信済み: `folder.aliases.sent = "[Gmail]/送信済みメール"`

## Git リモート

- `origin`: openclaw/openclaw（read-only）
- `fork`: sablehead/openclaw（push 可能）
- ブランチ: `hedwig`

## Fly secrets（設定済み）

- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET` (末尾 `pl2r`)
- `GOOGLE_GMAIL_REFRESH_TOKEN`
- `GOOGLE_API_KEY`
- `BRAVE_API_KEY`
- `YAHOO_APP_ID`
- `GOOGLE_PLACES_API_KEY`

## fly-start.sh の上書き（/data 優先）

`fly-root-init.sh` は `/data/fly-start.sh` が存在すればイメージ内の
`/app/fly-start.sh` より優先して実行する。sftp + restart での緊急修正が
再起動後も生き残るための仕組み。

⚠️ **イメージデプロイ後は `/data/fly-start.sh` を削除すること。**
残しておくと、新しいイメージに入った fly-start.sh が永遠に使われない。

```sh
fly ssh console -C "rm /data/fly-start.sh"
fly machine restart 1854407b453318
```

## 今後 fly deploy が必要になったら

1. 推奨: `git push fork hedwig` → CI ビルド → `fly deploy --image`（上記参照）
2. fly-start.sh だけなら sftp で `/data/fly-start.sh` に置いて restart が最速
   （イメージ更新時に消し忘れないこと）
3. `fly deploy --remote-only` は push 切断問題が直るまで使わない
