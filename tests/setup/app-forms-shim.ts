// Test stub for `$app/forms` — SSR rendering never runs the enhance action.
export const enhance = () => ({ destroy() {} });
export const applyAction = async () => {};
export const deserialize = (v: string) => JSON.parse(v);
