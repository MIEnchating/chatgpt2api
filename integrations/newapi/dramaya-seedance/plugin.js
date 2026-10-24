// 由视频契约生成；不包含 API Key。请在 New API 渠道中配置实际密钥。
const CONFIG = {
  "contract": {
    "name": "Dramaya Seedance A 视频",
    "models": [
      "seedance2.0-A",
      "seedance2.5-A"
    ],
    "priority": 0,
    "driver": "custom-video",
    "transport": {
      "local_material": "url",
      "multipart_file_field": "",
      "multipart_repeatable": false,
      "multipart_mixed_urls": false,
      "create_path": "/v1/videos",
      "query_path": "/v1/videos/{task_id}"
    },
    "artifact": {
      "mode": "task_content",
      "content_path": "/v1/videos/{task_id}/content",
      "auth": "relay",
      "allowed_hosts": []
    },
    "capability": {
      "sizes": [
        "16:9",
        "9:16",
        "1:1",
        "4:3",
        "3:4",
        "21:9",
        "Auto"
      ],
      "seconds": [
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15
      ],
      "resolutions": [
        "480p",
        "720p",
        "1080p"
      ],
      "default_size": "16:9",
      "default_seconds": 4,
      "default_resolution": "480p",
      "references": {
        "image": 9,
        "video": 3,
        "audio": 3,
        "total": 12
      },
      "first_frame_image_limit": 2,
      "reference_mode": true,
      "audio_control": "none",
      "watermark": false
    },
    "generation": {
      "selection": "infer",
      "default_mode": "text-to-video",
      "modes": [
        {
          "id": "text-to-video",
          "label": "文生视频",
          "kind": "text",
          "request_value": "text-to-video",
          "materials": {
            "first_frame": {
              "min": 0,
              "max": 0
            },
            "last_frame": {
              "min": 0,
              "max": 0
            },
            "image": {
              "min": 0,
              "max": 0
            },
            "video": {
              "min": 0,
              "max": 0
            },
            "audio": {
              "min": 0,
              "max": 0
            },
            "total": {
              "min": 0,
              "max": 0
            }
          }
        },
        {
          "id": "image-to-video",
          "label": "首尾帧生视频",
          "kind": "image",
          "request_value": "image-to-video",
          "materials": {
            "first_frame": {
              "min": 1,
              "max": 1
            },
            "last_frame": {
              "min": 1,
              "max": 1
            },
            "image": {
              "min": 0,
              "max": 0
            },
            "video": {
              "min": 0,
              "max": 0
            },
            "audio": {
              "min": 0,
              "max": 0
            },
            "total": {
              "min": 2,
              "max": 2
            }
          }
        },
        {
          "id": "reference-to-video",
          "label": "参考素材生视频",
          "kind": "reference",
          "request_value": "reference-to-video",
          "materials": {
            "first_frame": {
              "min": 0,
              "max": 0
            },
            "last_frame": {
              "min": 0,
              "max": 0
            },
            "image": {
              "min": 0,
              "max": 9
            },
            "video": {
              "min": 0,
              "max": 3
            },
            "audio": {
              "min": 0,
              "max": 3
            },
            "total": {
              "min": 1,
              "max": 12
            }
          }
        }
      ]
    },
    "rules": [
      {
        "when": {
          "field": "first_frame",
          "operator": "present"
        },
        "require": [
          "last_frame"
        ],
        "force_values": {
          "size": "Auto"
        },
        "ui": {},
        "message": "首尾帧必须成对使用，画幅比例为 Auto"
      }
    ],
    "request": {
      "duration_field": "duration",
      "duration_value_type": "number",
      "aspect_ratio_field": "aspect_ratio",
      "resolution_field": "resolution",
      "generate_audio_field": "",
      "watermark_field": "",
      "generation_mode_field": "",
      "first_frame_field": "first_frame_url",
      "last_frame_field": "last_frame_url",
      "reference_images_field": "image_urls",
      "reference_videos_field": "reference_video_urls",
      "reference_audios_field": "reference_audio_urls"
    },
    "polling": {
      "interval_seconds": 5,
      "timeout_seconds": 1800,
      "task_id_fields": [
        "id"
      ],
      "status_fields": [
        "status"
      ],
      "progress_fields": [
        "progress"
      ],
      "error_fields": [
        "error.message"
      ],
      "queued_statuses": [
        "queued"
      ],
      "processing_statuses": [
        "running",
        "in_progress",
        "processing",
        "pending",
        "cancel_requested"
      ],
      "success_statuses": [
        "completed"
      ],
      "failure_statuses": [
        "failed",
        "cancelled",
        "expired"
      ],
      "result_fields": [
        "video_url",
        "data[0].url"
      ]
    },
    "model_profiles": [
      {
        "model": "seedance2.0-A",
        "capability": {
          "sizes": [
            "16:9",
            "9:16",
            "1:1",
            "4:3",
            "3:4",
            "21:9",
            "Auto"
          ],
          "seconds": [
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15
          ],
          "resolutions": [
            "480p",
            "720p",
            "1080p"
          ],
          "default_size": "16:9",
          "default_seconds": 4,
          "default_resolution": "480p",
          "references": {
            "image": 9,
            "video": 3,
            "audio": 3,
            "total": 12
          },
          "first_frame_image_limit": 2,
          "reference_mode": true,
          "audio_control": "none",
          "watermark": false
        },
        "generation": {
          "selection": "infer",
          "default_mode": "text-to-video",
          "modes": [
            {
              "id": "text-to-video",
              "label": "文生视频",
              "kind": "text",
              "request_value": "text-to-video",
              "materials": {
                "first_frame": {
                  "min": 0,
                  "max": 0
                },
                "last_frame": {
                  "min": 0,
                  "max": 0
                },
                "image": {
                  "min": 0,
                  "max": 0
                },
                "video": {
                  "min": 0,
                  "max": 0
                },
                "audio": {
                  "min": 0,
                  "max": 0
                },
                "total": {
                  "min": 0,
                  "max": 0
                }
              }
            },
            {
              "id": "image-to-video",
              "label": "首尾帧生视频",
              "kind": "image",
              "request_value": "image-to-video",
              "materials": {
                "first_frame": {
                  "min": 1,
                  "max": 1
                },
                "last_frame": {
                  "min": 1,
                  "max": 1
                },
                "image": {
                  "min": 0,
                  "max": 0
                },
                "video": {
                  "min": 0,
                  "max": 0
                },
                "audio": {
                  "min": 0,
                  "max": 0
                },
                "total": {
                  "min": 2,
                  "max": 2
                }
              }
            },
            {
              "id": "reference-to-video",
              "label": "参考素材生视频",
              "kind": "reference",
              "request_value": "reference-to-video",
              "materials": {
                "first_frame": {
                  "min": 0,
                  "max": 0
                },
                "last_frame": {
                  "min": 0,
                  "max": 0
                },
                "image": {
                  "min": 0,
                  "max": 9
                },
                "video": {
                  "min": 0,
                  "max": 3
                },
                "audio": {
                  "min": 0,
                  "max": 3
                },
                "total": {
                  "min": 1,
                  "max": 12
                }
              }
            }
          ]
        },
        "rules": [
          {
            "when": {
              "field": "first_frame",
              "operator": "present"
            },
            "require": [
              "last_frame"
            ],
            "force_values": {
              "size": "Auto"
            },
            "ui": {},
            "message": "首尾帧必须成对使用，画幅比例为 Auto"
          }
        ]
      },
      {
        "model": "seedance2.5-A",
        "capability": {
          "sizes": [
            "16:9",
            "9:16",
            "1:1",
            "4:3",
            "3:4",
            "21:9",
            "Auto"
          ],
          "seconds": [
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15,
            16,
            17,
            18,
            19,
            20,
            21,
            22,
            23,
            24,
            25,
            26,
            27,
            28,
            29,
            30
          ],
          "resolutions": [
            "480p",
            "720p",
            "1080p"
          ],
          "default_size": "16:9",
          "default_seconds": 4,
          "default_resolution": "480p",
          "references": {
            "image": 30,
            "video": 10,
            "audio": 10,
            "total": 50
          },
          "first_frame_image_limit": 0,
          "reference_mode": true,
          "audio_control": "none",
          "watermark": false
        },
        "generation": {
          "selection": "infer",
          "default_mode": "text-to-video",
          "modes": [
            {
              "id": "text-to-video",
              "label": "文生视频",
              "kind": "text",
              "request_value": "text-to-video",
              "materials": {
                "first_frame": {
                  "min": 0,
                  "max": 0
                },
                "last_frame": {
                  "min": 0,
                  "max": 0
                },
                "image": {
                  "min": 0,
                  "max": 0
                },
                "video": {
                  "min": 0,
                  "max": 0
                },
                "audio": {
                  "min": 0,
                  "max": 0
                },
                "total": {
                  "min": 0,
                  "max": 0
                }
              }
            },
            {
              "id": "reference-to-video",
              "label": "参考素材生视频",
              "kind": "reference",
              "request_value": "reference-to-video",
              "materials": {
                "first_frame": {
                  "min": 0,
                  "max": 0
                },
                "last_frame": {
                  "min": 0,
                  "max": 0
                },
                "image": {
                  "min": 0,
                  "max": 30
                },
                "video": {
                  "min": 0,
                  "max": 10
                },
                "audio": {
                  "min": 0,
                  "max": 10
                },
                "total": {
                  "min": 1,
                  "max": 50
                }
              }
            }
          ]
        },
        "rules": []
      }
    ]
  },
  "options": {
    "key": "dramaya-seedance",
    "version": "1.0.1",
    "base_url": "https://video.dramaya.us",
    "models": [
      "seedance2.0-A",
      "seedance2.5-A"
    ],
    "auth_mode": "bearer",
    "auth_header": "",
    "download_mode": "signed_url",
    "result_fields": [
      "video_url",
      "data[0].url"
    ]
  }
};

/**
 * New API Task Plugin API v1 视频插件。
 * CONFIG 是生成时保存的契约快照；模型能力、字段路径和状态以该快照为准。
 * 创建、查询、计费和下载均由宿主调用，不依赖外部文件或运行时代码生成。
 * API Key 只从渠道 ctx.apiKey 读取，不写入此文件，也不返回给客户端。
 */
const contract = CONFIG.contract;
const options = CONFIG.options;
const profiles = contract.model_profiles;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function usageSchema(profile) {
  const schema = { seconds: { type: "number", unit: "second", description: { zh: "请求视频时长", en: "Requested duration" } } };
  if (profile.capability.resolutions.length) {
    schema.resolution = { enum: profile.capability.resolutions, description: { zh: "输出清晰度", en: "Output resolution" } };
  }
  return schema;
}

// 一个插件绑定多个精确模型；不同模型的参数和定价字段分别声明。
export const meta = {
  apiVersion: 1,
  key: options.key,
  name: contract.name,
  version: options.version,
  author: { name: "Video contract generator" },
  description: { zh: "由视频契约生成的 JSON 异步视频插件", en: "Contract-generated JSON video task plugin" },
  baseUrl: options.base_url,
  models: options.models,
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: usageSchema(profiles[0]),
  usageProfiles: profiles.slice(1).map(profile => ({ models: [profile.model], schema: usageSchema(profile) })),
  ...(options.download_mode === "authenticated_url" && contract.artifact.allowed_hosts.length
    ? { allowedHosts: contract.artifact.allowed_hosts } : {}),
};

function profileFor(model) {
  const profile = profiles.find(item => item.model === model);
  if (!profile) throw new Error("模型不属于此插件: " + model);
  return profile;
}

// 路径只接受生成器验证过的字段名和数组下标，不使用 eval，也不访问原型属性。
function segments(path) {
  return path.replace(/\[([0-9]+)\]/g, (_match, index) => "." + Number(index)).split(".");
}

function read(value, path) {
  if (!path) return undefined;
  for (const part of segments(path)) {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch (_) { return undefined; }
    }
    if (!value || typeof value !== "object" || !own(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function write(target, path, value) {
  if (!path || value === undefined) return;
  const parts = segments(path);
  let current = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) current[part] = value;
    else {
      if (!own(current, part)) current[part] = /^[0-9]+$/.test(parts[index + 1]) ? [] : {};
      current = current[part];
    }
  });
}

function firstString(body, paths) {
  for (const path of paths) {
    const value = read(body, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function count(value) {
  if (value === undefined || value === null || value === false) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  return 1;
}

const materialFields = {
  first_frame: "first_frame_field", last_frame: "last_frame_field",
  reference_image: "reference_images_field", reference_video: "reference_videos_field", reference_audio: "reference_audios_field",
};
const materialRanges = { first_frame: "first_frame", last_frame: "last_frame", reference_image: "image", reference_video: "video", reference_audio: "audio" };

function ruleMatches(rule, values) {
  let value = values[rule.when.field];
  if (own(materialFields, rule.when.field)) value = count(value);
  return rule.when.operator === "present" ? count(value) > 0
    : String(value === undefined ? "" : value).trim().toLowerCase() === String(rule.when.value).trim().toLowerCase();
}

// 只允许当前生成模式声明的字段；连同嵌套对象中的未知字段一起拒绝。
function checkFields(body, paths) {
  const leaves = paths.filter(Boolean).map(path => segments(path).join("."));
  function visit(value, path) {
    if (leaves.includes(path)) return;
    if (path && !leaves.some(leaf => leaf.startsWith(path + "."))) throw new Error("契约未声明字段: " + path);
    if (!value || typeof value !== "object") throw new Error("嵌套字段必须是对象或数组: " + path);
    for (const key of Object.keys(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("请求包含保留字段");
      const next = path ? path + "." + key : key;
      // JSON 数组的空位会表现为 null；仅允许它作为已声明下标前的占位。
      if (Array.isArray(value) && value[key] === null && !leaves.some(leaf => leaf === next || leaf.startsWith(next + "."))) continue;
      visit(value[key], next);
    }
  }
  visit(body, "");
}

/**
 * 读取契约定义的实际请求字段，校验所选模型的参数与素材限制。
 * 条件规则只对原始输入应用一次；返回新对象，不修改 ctx.requestBody。
 * 解码、提交和用量钩子各自从同一原始输入计算，避免多次应用强制规则。
 */
function normalize(body, model) {
  if (!object(body)) throw new Error("请求必须是 JSON 对象");
  const profile = profileFor(model);
  const cap = profile.capability;
  const fields = contract.request;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("请输入视频提示词");
  const explicitMode = read(body, fields.generation_mode_field);
  let mode;
  if (explicitMode !== undefined) {
    mode = profile.generation.modes.find(item => (item.request_value || item.id) === explicitMode);
  } else {
    const hasReference = [fields.reference_images_field, fields.reference_videos_field, fields.reference_audios_field]
      .some(path => Array.isArray(read(body, path)) && count(read(body, path)) > 0);
    const hasFrame = [fields.first_frame_field, fields.last_frame_field]
      .some(path => typeof read(body, path) === "string" && count(read(body, path)) > 0);
    const kind = hasReference ? "reference" : hasFrame ? "image" : "text";
    mode = profile.generation.modes.find(item => item.kind === kind);
  }
  if (!mode) throw new Error("当前模型不支持所选生成模式或素材组合");
  const allowed = ["model", "prompt", fields.duration_field, fields.aspect_ratio_field, fields.resolution_field,
    fields.generate_audio_field, fields.watermark_field, fields.generation_mode_field];
  const values = {};
  for (const key of Object.keys(materialFields)) {
    const range = mode.materials[materialRanges[key]];
    const path = fields[materialFields[key]];
    const active = range.max > 0;
    const value = active ? read(body, path) : undefined;
    if (active) allowed.push(path);
    const multiple = key.startsWith("reference_");
    if (value !== undefined && (multiple ? !Array.isArray(value) : typeof value !== "string")) {
      throw new Error(path + (multiple ? " 必须是 URL 数组" : " 必须是 URL 字符串"));
    }
    values[key] = value === undefined ? (multiple ? [] : "") : value;
    const amount = count(values[key]);
    if (amount < range.min || amount > range.max) throw new Error(mode.label + "的素材数量不符合契约: " + key);
    for (const url of multiple ? values[key] : amount ? [values[key]] : []) {
      if (typeof url !== "string" || !/^https?:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/.test(url)) {
        throw new Error("素材必须使用不含凭据的公网 HTTP(S) URL");
      }
    }
  }
  checkFields(body, allowed);
  const total = Object.keys(materialFields).reduce((sum, key) => sum + count(values[key]), 0);
  if (total < mode.materials.total.min || total > mode.materials.total.max) throw new Error("素材合计数量不符合契约");
  const duration = read(body, fields.duration_field);
  if (duration !== undefined && (fields.duration_value_type === "string"
    ? typeof duration !== "string" || !/^[0-9]+$/.test(duration)
    : typeof duration !== "number" || !Number.isInteger(duration))) throw new Error("视频时长的类型不符合契约");
  values.duration = duration === undefined ? cap.default_seconds : Number(duration);
  const size = read(body, fields.aspect_ratio_field);
  const resolution = read(body, fields.resolution_field);
  values.size = size === undefined ? cap.default_size : size;
  values.resolution = resolution === undefined ? cap.default_resolution : resolution;
  for (const key of ["generate_audio", "watermark"]) {
    const value = read(body, fields[key + "_field"]);
    if (value !== undefined && typeof value !== "boolean") throw new Error(key + " 必须是布尔值");
    values[key] = value === undefined ? false : value;
  }
  values.generate_audio = cap.audio_control === "always" || cap.audio_control === "toggle" && values.generate_audio;
  values.watermark = cap.watermark && values.watermark;
  for (const rule of profile.rules) {
    if (!ruleMatches(rule, values)) continue;
    for (const key of Object.keys(rule.force_values || {})) {
      const value = rule.force_values[key];
      values[key] = key === "duration" ? Number(value)
        : ["generate_audio", "watermark"].includes(key) ? ["true", "1", "t"].includes(value.toLowerCase()) : value;
    }
  }
  if (cap.audio_control !== "toggle") values.generate_audio = cap.audio_control === "always";
  if (!cap.watermark) values.watermark = false;
  for (const rule of profile.rules) {
    if (!ruleMatches(rule, values)) continue;
    if ((rule.require || []).some(key => count(values[key]) === 0)
      || (rule.require_any || []).length && !rule.require_any.some(key => count(values[key]) > 0)
      || (rule.forbid || []).some(key => count(values[key]) > 0)
      || Object.keys(rule.limits || {}).some(key => count(values[key]) > rule.limits[key])) throw new Error(rule.message);
  }
  if (!Number.isInteger(values.duration) || !cap.seconds.includes(values.duration)) throw new Error("当前模型不支持所选时长");
  if (typeof values.size !== "string" || cap.sizes.length && !cap.sizes.includes(values.size)) throw new Error("当前模型不支持所选画幅");
  if (typeof values.resolution !== "string" || cap.resolutions.length && !cap.resolutions.includes(values.resolution)) throw new Error("当前模型不支持所选清晰度");
  const result = { model, prompt: body.prompt };
  write(result, fields.duration_field, fields.duration_value_type === "string" ? String(values.duration) : values.duration);
  if (values.size) write(result, fields.aspect_ratio_field, values.size);
  if (values.resolution) write(result, fields.resolution_field, values.resolution);
  write(result, fields.generate_audio_field, values.generate_audio);
  write(result, fields.watermark_field, values.watermark);
  write(result, fields.generation_mode_field, mode.request_value || mode.id);
  for (const key of Object.keys(materialFields)) {
    if (count(values[key]) > 0) write(result, fields[materialFields[key]], values[key]);
  }
  return { body: result, values, action: mode.kind === "text" ? "text_to_video" : "image_to_video" };
}

// Key 只用于明确配置的上游 API 请求；签名视频下载不会调用此函数。
function authHeaders(ctx) {
  if (options.auth_mode === "none") return {};
  if (typeof ctx.apiKey !== "string" || !ctx.apiKey.trim()) throw new Error("请在 New API 渠道中配置上游密钥");
  return options.auth_mode === "bearer" ? { Authorization: "Bearer " + ctx.apiKey } : { [options.auth_header]: ctx.apiKey };
}

function endpoint(ctx, path, taskId) {
  if (path.includes("{task_id}")) {
    if (typeof taskId !== "string" || !taskId.trim() || [".", ".."].includes(taskId)) throw new Error("缺少有效的上游任务 ID");
    path = path.replace("{task_id}", encodeURIComponent(taskId));
  }
  return ctx.baseUrl.replace(/\/+$/, "") + path;
}

export function buildSubmitRequest(ctx) {
  if ((ctx.files || []).length) throw new Error("此插件使用 JSON 和素材 URL，不接受文件上传");
  const request = normalize(ctx.requestBody, ctx.upstreamModel);
  // Convert the public plugin fields to Dramaya's typed reference objects.
  const references = [];
  const mappings = [
    ["first_frame_url", "image", "first_frame"],
    ["last_frame_url", "image", "last_frame"],
    ["image_urls", "image", "reference"],
    ["reference_video_urls", "video", "reference"],
    ["reference_audio_urls", "audio", "reference"],
  ];
  for (const [field, type, role] of mappings) {
    const value = request.body[field];
    if (value !== undefined) {
      for (const source of Array.isArray(value) ? value : [value]) references.push({ type, role, source });
      delete request.body[field];
    }
  }
  if (references.length) request.body.references = references;
  return { url: endpoint(ctx, contract.transport.create_path), method: "POST", headers: { ...authHeaders(ctx), "Content-Type": "application/json" }, body: request.body };
}

export function parseSubmitResponse(_ctx, response) {
  const body = response.body;
  if (!object(body)) throw new Error("上游创建响应必须是 JSON 对象");
  const taskId = firstString(body, contract.polling.task_id_fields);
  if (!taskId || [".", ".."].includes(taskId)) throw new Error("上游创建响应缺少有效任务 ID");
  const result = { taskId, taskData: body };
  // 创建响应可以仅包含任务 ID；若同时返回状态，则必须按契约识别。
  if (contract.polling.status_fields.some(path => read(body, path) !== undefined)) {
    const parsed = parseTaskResult({ taskId }, body);
    if (parsed.status === "UNKNOWN") throw new Error(parsed.reason);
    if (["SUCCESS", "FAILURE"].includes(parsed.status)) result.immediate = parsed;
  }
  return result;
}

export function buildQueryRequest(ctx) {
  return { url: endpoint(ctx, contract.transport.query_path, ctx.taskId), method: "GET", headers: authHeaders(ctx) };
}

export function parseTaskResult(ctx, body) {
  if (!object(body)) return { status: "UNKNOWN", reason: "上游任务响应必须是 JSON 对象" };
  const id = firstString(body, contract.polling.task_id_fields);
  if (id && id !== ctx.taskId) return { status: "UNKNOWN", reason: "上游响应任务 ID 不匹配" };
  const status = firstString(body, contract.polling.status_fields).toLowerCase();
  const groups = [["queued_statuses", "QUEUED"], ["processing_statuses", "IN_PROGRESS"], ["success_statuses", "SUCCESS"], ["failure_statuses", "FAILURE"]];
  const matched = groups.find(([key]) => contract.polling[key].includes(status));
  if (!matched) return { status: "UNKNOWN", reason: "上游状态未在契约中声明" };
  const result = { status: matched[1] };
  for (const path of contract.polling.progress_fields) {
    const value = read(body, path);
    if (typeof value !== "number" && typeof value !== "string" || String(value).trim() === "") continue;
    const progress = Number(String(value).trim().replace(/%$/, ""));
    if (Number.isFinite(progress) && progress >= 0 && progress <= 100) { result.progress = Math.round(progress) + "%"; break; }
  }
  if (result.status === "SUCCESS") result.progress = "100%";
  if (result.status === "FAILURE") result.reason = firstString(body, contract.polling.error_fields) || "上游视频任务失败";
  return result;
}

// 只提供请求事实；实际单价和结算规则由 New API 后台配置。
export function extractUsage(ctx) {
  const values = normalize(ctx.requestBody, ctx.upstreamModel).values;
  if (ctx.usagePurpose === "billing_ratios") return {};
  const usage = { seconds: values.duration };
  if (profileFor(ctx.upstreamModel).capability.resolutions.length) usage.resolution = values.resolution;
  return usage;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

function resultURL(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) { const found = resultURL(item); if (found) return found; }
  }
  return "";
}

/**
 * 下载策略在生成插件时明确选择，不自动尝试多个接口或复用过期地址。
 * signed_url：带 Key 查询任务，再用不带 Key 的签名地址下载，避免跨域泄露。
 * task_content：直接访问契约声明的产物路径；带凭据跨域跳转会被宿主拒绝。
 * authenticated_url：刷新结果地址后带渠道 Key 下载，只允许宿主授权的域名。
 */
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const method = ctx.clientRequest.method;
  if (!["GET", "HEAD"].includes(method)) throw new Error("视频下载仅支持 GET/HEAD");
  if (options.download_mode === "task_content") {
    const url = endpoint(ctx, contract.artifact.content_path, ctx.upstreamTaskId);
    return options.auth_mode === "none" ? { url, method, credentialless: true } : { url, method, headers: authHeaders(ctx) };
  }
  const response = utils.fetch({ url: endpoint(ctx, contract.transport.query_path, ctx.upstreamTaskId), method: "GET", headers: authHeaders(ctx) });
  if (response.status !== 200) throw new Error("视频结果查询失败，状态码 " + response.status);
  if (parseTaskResult({ taskId: ctx.upstreamTaskId }, response.body).status !== "SUCCESS") throw new Error("视频尚未完成或任务状态不匹配");
  let url = "";
  for (const path of options.result_fields) { url = resultURL(read(response.body, path)); if (url) break; }
  if (url.startsWith("/") && !url.startsWith("//")) url = endpoint(ctx, url);
  if (!/^https:\/\/[^/?#@\s]+(?:[/?][^#\s]*)?$/.test(url)) throw new Error("查询结果中没有有效的 HTTPS 视频地址");
  if (options.download_mode === "signed_url" || options.auth_mode === "none") return { url, method, credentialless: true };
  return { url, method, headers: authHeaders(ctx) };
}

// 只声明 OpenAI 视频协议；不生成供应商原生路由，也不开放编辑/remix 功能。
export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("此插件只接受 JSON 请求");
      const normalized = normalize(ctx.body.value, ctx.model);
      return { kind: "submit", model: ctx.model, action: normalized.action, requestBody: ctx.body.value };
    },
    render(_ctx, task) {
      // 公共 ID、状态和时间戳由宿主补充；不暴露上游 ID、Key 或临时签名地址。
      return task.status === "FAILURE" ? { error: { code: "video_generation_failed", message: task.fail_reason || "视频生成失败" } } : {};
    },
  },
};
