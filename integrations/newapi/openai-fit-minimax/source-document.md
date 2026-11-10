# openai.fit 模型接入文档

更新日期：2026-11-03　服务地址：`https://openai.fit`

本文覆盖本站模型广场当前列出、已开放调用的模型（已下架或仍在适配、暂不可生成的模型不列出），并区分已成功生成、仅列出和已知不可用三种状态。请求前用你的密钥查询 `GET /v1/models`；价格以模型广场或 `GET /api/pricing` 的实时规则为准，最终扣费以后台使用日志为准。本文没有标为已实测的素材数量与参数组合，不代表每一种组合均已成功出片。

> ⚠️ **不推荐文生视频。** 只写文字、不带参考图时，人物、产品和场景的外观全靠模型自由发挥，画面不可控、效果不稳定，返工概率高。**请至少带一张参考图**（能用多图参考的模型优先用多图参考），用参考图锁定主体外观，再用提示词描述动作和镜头。本文各模型的示例也都按带参考图的写法给出。

---

## 1. 快速开始

### 1.1 鉴权

所有接口用同一个 API 密钥，放在请求头里：

```http
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

密钥在本站控制台创建。没有第二套签名、时间戳或 AppID，也不需要在请求体里再带一次密钥。

### 1.2 取可用模型

```bash
curl https://openai.fit/v1/models \
  -H "Authorization: Bearer $OPENAI_FIT_KEY"
```

只使用返回的 `data[].id`。**模型 ID 是精确值，不要改写大小写、不要删空格**（例如 `seedance 2.0 mini-GT`、`seedance2.0 mini Love`、`seedance 2.0 fast cheap`、`seedance 2.5-GT` 中间是普通空格，`seedance-2.0-Neko` 里的 `N`、`wan3.0-video` 全小写，都要照写）。本文列出的 ID 都可以直接复制。

### 1.3 接口总览

| 用途 | 方法与路径 |
|---|---|
| 模型列表 | `GET /v1/models` |
| 提交视频任务 | `POST /v1/videos` |
| 查询视频任务 | `GET /v1/videos/{id}` |
| 下载成片 | `GET /v1/videos/{id}/content` |
| 素材托管 | `POST /v1/uploads`、`GET /v1/uploads/{id}.{ext}`、`DELETE /v1/uploads/{id}` |
| 文生图 | `POST /v1/images/generations` |
| 图生图 | `POST /v1/images/edits` |
| Gemini 兼容格式图片 | `POST /v1beta/models/{model}:generateContent` |
| 文本对话（Responses） | `POST /v1/responses`；GPT、Grok、GLM、Kimi 模型可用，GPT 模型必须设置 `stream:true` |
| 对话兼容写法 | `POST /v1/chat/completions`；全部文本模型都可用，流式与非流式都支持 |
| Claude 原生格式 | `POST /v1/messages`（Anthropic Messages 格式），仅 Claude 模型 |



## 3. 视频统一流程

所有视频模型都走同一套接口：**提交 → 轮询 → 下载**。不同模型的差异只在请求体的字段上。

> ⚠️ **不推荐文生视频。** 只写文字、不带参考图时，人物、产品和场景的外观全靠模型自由发挥，画面不可控、效果不稳定，返工概率高。**请至少带一张参考图**（能用多图参考的模型优先用多图参考），用参考图锁定主体外观，再用提示词描述动作和镜头。本文各模型的示例也都按带参考图的写法给出。

### 3.1 提交任务

```bash
curl https://openai.fit/v1/videos \
  -H "Authorization: Bearer $OPENAI_FIT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance 2.0 mini-GT",
    "prompt": "参考图中的人物沿着海边向镜头走来，镜头缓慢推近",
    "seconds": 15,
    "resolution": "480p",
    "ratio": "9:16",
    "images": ["https://openai.fit/v1/uploads/<id>.jpg"]
  }'
```

返回只代表任务已受理，不代表已生成：

```json
{"id": "task_xxx", "object": "video", "status": "queued", "model": "seedance 2.0 mini-GT", "progress": 0, "created_at": 1789300000}
```

HTTP 400 表示参数被拒，响应体 `error.message` 是原因，此时不扣费。

### 3.2 轮询状态

```bash
curl https://openai.fit/v1/videos/task_xxx \
  -H "Authorization: Bearer $OPENAI_FIT_KEY"
```

状态机：`queued` → `in_progress` → `completed` 或 `failed`。`progress` 是 0–100 的整数。失败时带 `error`：

```json
{"id": "task_xxx", "object": "video", "status": "failed", "progress": 100,
 "error": {"code": "video_generation_failed", "message": "参考视频帧率过低，需 ≥16 fps（实际 12 fps）"}}
```

- **轮询间隔 10–20 秒。** 更密的轮询不会让任务变快，还可能触发 429。
- **本站约每 1 分钟同步一次进度**（2026-10-08 起，各模型互不影响）：出片后，最多约 1 分钟这里就会变成 `completed`。
- **轮询上限至少 60 分钟。** ✅ 成功的任务通常 2–20 分钟出片；但生成阶段失败时服务端会反复重试，往往 45–60 分钟后才返回 `failed`。过早放弃会让你以为任务丢了，实际它还在跑（失败会自动退款）。
- **任务记录保留 24 小时** 📄，超过后 `GET /v1/videos/{id}` 返回 404，请及时把成片取走。

### 3.3 下载成片

```bash
curl https://openai.fit/v1/videos/task_xxx/content \
  -H "Authorization: Bearer $OPENAI_FIT_KEY" \
  -o result.mp4
```

只有 `status` 为 `completed` 且 `/content` 下载成功才算真正完成。**成片一律通过本站 `/content` 取**，不要依赖响应里出现的任何外部链接——那些链接可能随时失效。`/content` 支持 `HEAD`。

**下载一次后请自己保存，不要反复整段拉取。** 同一个密钥在 10 分钟内对同一条成片整段下载（不带 `Range` 或 `Range: bytes=0-`）超过 10 次，会返回 **429**（`artifact_download_limited`，`Retry-After: 600`），停 10 分钟自动恢复；断点续传、拖动播放、下载其他成片不受影响。

### 3.4 完整 Python 示例（提交 → 轮询 → 下载）

```python
import time, requests

BASE = "https://openai.fit"
KEY  = "sk-..."                      # 你的 API 密钥
H    = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}

body = {
    "model": "seedance 2.0 mini-GT",
    "prompt": "海边日落，参考图中的人物沿沙滩向镜头走来，镜头缓慢推近",
    "seconds": 15,                             # 本模型只做 10 或 15 秒
    "resolution": "480p",
    "ratio": "9:16",
    "images": ["https://openai.fit/v1/uploads/<id>.jpg"],      # 参考图最多 9 张
}

r = requests.post(BASE + "/v1/videos", headers=H, json=body, timeout=300)
if r.status_code == 400:                       # 参数被拒，未扣费
    raise SystemExit(r.json()["error"]["message"])
r.raise_for_status()
task_id = r.json()["id"]
print("task:", task_id)

deadline = time.time() + 75 * 60               # 生成失败最晚 60 分钟后才返回
while time.time() < deadline:
    time.sleep(15)                             # 轮询间隔 10–20 秒
    s = requests.get(f"{BASE}/v1/videos/{task_id}", headers=H, timeout=60).json()
    print(s["status"], s.get("progress"))
    if s["status"] == "completed":
        mp4 = requests.get(f"{BASE}/v1/videos/{task_id}/content",
                           headers=H, timeout=600).content
        open("result.mp4", "wb").write(mp4)
        break
    if s["status"] == "failed":                # 已自动全额退款
        raise SystemExit(s.get("error", {}).get("message"))
else:
    raise SystemExit("超过 75 分钟仍未结束，请带任务 ID 联系客服")
```

### 3.5 通用字段

下表是所有视频模型共有的字段，每个模型各自支持的取值范围、参考素材字段见各自章节。

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `model` | 是 | 精确模型 ID | 大小写、空格、下划线都要一致 |
| `prompt` | 是 | 非空字符串 | 少数模型允许只给参考素材不给文字，见各自章节 |
| `seconds` | 否 | 整数秒 | 时长。**一次只传一个时长字段**：`seconds`、`duration`、`video_length` 是别名，不同模型读取的名字不同。部分模型同传多个且取值不等会直接报错（400，不扣费），其余模型不会报错，请自行保证只传一个 |
| `ratio` | 否 | 如 `9:16` | 画幅。同样**一次只传一个**：`ratio`、`aspect_ratio`、`size` 是同一类字段。带参考图时输出画幅可能跟随参考图 ✅ |
| `resolution` | 否 | 枚举 | 只有各模型章节列出时才传，取值要完全一致（含大小写，例如 Wan 用 `720P`、Seedance 用 `720p`）。传枚举外的值会 400 |
| `metadata` | 否 | 对象 | 兜底容器：本站先取顶层字段，顶层没有时再从 `metadata` 里取同名字段。`metadata` 本身不会原样转发。适合把一批可选参数打包，不影响主字段 ✅。**部分按次计费的模型不读 `metadata`，最稳妥的写法是把参数都写在顶层**；个别模型在顶层与容器内同名键的值不同时会直接拒绝 |

**素材一律用链接或内嵌数据，不要传本地路径。** 除 `minimax H3-self` 外，视频接口不接受 multipart 文件上传；`C:\a.jpg` 这样的本地路径不是 URL，会被当成无效素材。本地文件请先走第 4 节的 `/v1/uploads` 换成 HTTPS 链接。

---



### `minimax H3 768 Spica`

| 项目 | 值 |
|---|---|
| 价格 | ¥0.58/条 |
| 时长 | 固定 15 秒 |
| 清晰度 | `768P` |
| 画幅 | `9:16` / `16:9` |
| 参考素材上限 | 图 9 / 视频 0 / 音频 0 |
| 可用分组 | 默认分组 |

**模型说明**（与模型广场一致）：minimax H3 768 Spica 视频生成（MiniMax H3，固定 15 秒、768P）。按次计费 ¥0.58/条，与参考图数量无关，失败不收费。POST /v1/videos，model、prompt 必填；seconds 固定 15（可不传）；resolution 固定 768P（可不传）；ratio 指定画幅 9:16 或 16:9。参考图用 image_urls（最多 9 张），必须是公网 HTTPS 链接，本地图片可先通过 POST /v1/uploads 托管；暂不支持首尾帧、参考视频和参考音频（传了直接报错、不扣费）。GET /v1/videos/{task_id} 查询，GET /v1/videos/{task_id}/content 下载。


### `minimax H3-self`

| 项目 | 值 |
|---|---|
| 价格 | ¥0.04/秒（15 秒 ¥0.60） |
| 时长 | 1–15 秒（默认 5 秒） |
| 清晰度 | `480p竖` / `768p竖` / `480p横` / `768p横` |
| 画幅 | `9:16` / `16:9` |
| 参考素材上限 | 图 9 / 视频 0 / 音频 0 |
| 可用分组 | 默认分组 |

**模型说明**（与模型广场一致）：MiniMax H3 自部署视频生成；1–15 秒，480p/768p 横竖；支持最多 9 张参考图（ref_image_0–8），可用 URL、Base64 或 multipart 文件引用；不支持参考音频和参考视频（传了 ref_audio_* 会被忽略）；prompt 必填。¥0.04/秒，分组自动计费。


### `minimax-h3-chovy`

| 项目 | 值 |
|---|---|
| 价格 | 480P ¥0.75/条；768P ¥0.97/条；1088P ¥1.18/条；1440P ¥1.40/条 |
| 时长 | 固定 15 秒 |
| 清晰度 | `480P` / `768P` / `1088P` / `1440P` |
| 画幅 | `9:16` / `16:9` |
| 参考素材上限 | 图 9 / 视频 0 / 音频 3 |
| 可用分组 | 默认分组 |

**模型说明**（与模型广场一致）：minimax-h3-chovy 视频生成（MiniMax H3 多模式参考生视频，可带参考音频）。固定 15 秒、有声，按条计费：480P ¥0.75/条、768P ¥0.97/条、1088P ¥1.18/条、1440P ¥1.40/条，失败不收费。POST /v1/videos，model、prompt 必填；resolution 可选 480P / 768P / 1088P / 1440P（不传按 480P）；ratio 可选 9:16 / 16:9（不传按 9:16）；seconds 固定 15，可不传。参考图用 image_urls（最多 9 张公网 HTTPS 链接，本地图片可先通过 POST /v1/uploads 托管），提示词里可用 <Picture 1>…<Picture 9> 指代对应参考图。参考音频用 audio_urls（最多 3 段 mp3 / wav 公网 HTTPS 链接），提示词里可用 <Audio 1>…<Audio 3> 指代；提示词写了 <Audio N> 时要带上对应的音频。不支持首尾帧和参考视频。GET /v1/videos/{task_id} 查询，GET /v1/videos/{task_id}/content 下载。


### `minimax-H3-super`

| 项目 | 值 |
|---|---|
| 价格 | 480P ¥0.75/条；768P ¥0.97/条；1088P ¥1.18/条；1440P ¥1.40/条 |
| 时长 | 固定 15 秒 |
| 清晰度 | `480P` / `768P` / `1088P` / `1440P` |
| 画幅 | `9:16` / `16:9` |
| 参考素材上限 | 图 9 / 视频 0 / 音频 0 |
| 可用分组 | 默认分组 |

**模型说明**（与模型广场一致）：minimax-H3-super 视频生成（MiniMax H3 多模式参考生视频）。固定 15 秒、有声，按条计费：480P ¥0.75/条、768P ¥0.97/条、1088P ¥1.18/条、1440P ¥1.40/条，失败不收费。POST /v1/videos，model、prompt 必填；resolution 可选 480P / 768P / 1088P / 1440P（不传按 480P）；ratio 可选 9:16 / 16:9（不传按 9:16）；seconds 固定 15，可不传。参考图用 image_urls（最多 9 张公网 HTTPS 链接，本地图片可先通过 POST /v1/uploads 托管），提示词里可用 <Picture 1>…<Picture 9> 指代对应参考图。不收参考音频。不支持首尾帧和参考视频。GET /v1/videos/{task_id} 查询，GET /v1/videos/{task_id}/content 下载。
