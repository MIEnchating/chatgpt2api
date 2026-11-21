// The host fetches models with the channel URL and key; this module only converts the reply.
meta.relay = [{
  incoming_path: "/v1/models",
  upstream_path: options.models_path,
  converter: "plugin",
  ...(options.auth_mode === "none" ? { auth: { type: "none" } }
    : options.auth_mode === "header" ? { auth: { type: "header", name: options.auth_header, value: "{api_key}" } } : {}),
}];

export function convertResponse(_ctx, response) {
  if (response.status !== 200) {
    const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
    return { error: { status, message: "上游模型列表请求失败" } };
  }
  let body;
  try { body = JSON.parse(response.body); }
  catch (_) { throw new Error("上游模型列表不是有效 JSON"); }
  if (!object(body) || !Array.isArray(body.data)) {
    throw new Error("上游模型列表必须包含 data 数组");
  }
  // Models without a declared capability profile cannot be served by this video plugin.
  return { body: { object: "list", data: body.data.filter(model => object(model) && options.models.includes(model.id)) } };
}
