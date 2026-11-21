export function videoModelList(models) {
  const supported = new Set(models);
  return (_ctx, response) => {
    if (response.status !== 200) {
      return { error: { status: response.status, message: 'Upstream model listing request failed' } };
    }
    const { data } = JSON.parse(response.body);
    if (!Array.isArray(data)) {
      throw new Error('Upstream model list must contain a data array');
    }
    return { body: { object: 'list', data: data.filter(model => supported.has(model?.id)) } };
  };
}
