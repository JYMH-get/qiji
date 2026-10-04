/** 覆盖尚未拿到 taskId 的提交阶段及本地导出阶段。 */
let count = 0;
export function beginClientActivity() {
  count++;
  let ended = false;
  return () => { if (!ended) { ended = true; count--; } };
}
export const hasClientActivity = () => count > 0;
