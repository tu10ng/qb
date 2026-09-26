/**
 * 提示词模板的单趟填充。
 *
 * 不能用多趟 String.replace('{{x}}', v)：
 * - 用户内容（素材/说明/参数值）里本身写着 {{steps}} 会被后面的趟再替换掉；
 * - 替换串里的 $&、$` 会被当成替换模式改写。
 * 单趟扫描 + 函数式替换两个问题都不存在。
 */

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole)
}
