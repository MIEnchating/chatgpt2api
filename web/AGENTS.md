# 前端开发规范

遵守根目录规范。路径相对于 `web/`；开发服务及构建要求见 [运行规范](../.agents/rules/development.md)。

- 页面位于 `src/app/`，共享组件在 `src/components/`，API 与工具在 `src/lib/`，状态在 `src/store/`；组件文件使用 kebab-case，导出使用 PascalCase。
- 修改 UI 前先用 `rg --files` / `rg` 按用途检索现有组件、相关页面与工具，阅读候选实现、props 和调用示例，再决定方案。
- 优先复用业务封装，再组合 `src/components/ui/` 基础组件；仅导入 Button 不代表复用了已有确认、复制或加载交互。文案、图标和尺寸不同不构成重复实现的理由。
- 确认操作先查 `src/components/ui/confirm-dialog.tsx`，加载与空状态查同目录 `loading-state.tsx`、`empty-state.tsx`；新增实现须说明现有能力的具体缺口。
- 统一采用 [AI Elements / shadcn 官方体系](https://ui.shadcn.com/docs/ai-elements)：实现交互前先查 AI Elements，有对应组件或官方组合就优先复用，不以普通下拉、按钮或弹窗为由绕过。AI 输入、消息、推理、工具、任务及建议复用 `src/components/ai-elements/`；所有单选模型入口（含设置、Agent、工作流和节点）统一经过 `components/model-picker.tsx` 的 Model Selector，保留搜索、分组与选中语义，业务只提供模型、价格和禁用条件。没有对应 AI Elements 能力的普通表单、导航与下拉使用同一套 shadcn/ui 基础组件，排序使用下述共享组件；不引入平行组件库，不复制同类交互或另绘皮肤。AI Elements 本身由 shadcn/ui 组成，不以导入目录或 `data-ai-element` 标记判断覆盖。
- AI Elements 与 shadcn/ui 保持官方默认样式，优先使用组件已有的 `variant`、`size`；`className` 仅补充布局、尺寸约束与交互必需的状态，不额外定制配色、圆角、阴影或焦点效果。卡片、提示、徽标、消息、代码块和输入框的外层也复用组件，不通过原生包装层另绘皮肤。
- 导航和列表的左对齐、多行条目的纵向排列与自适应高度、滚动区的高度约束及嵌套滚动条间距属于布局约束，清理皮肤样式时保留。矮屏下保留外层工作区滚动，横向导航和内嵌区域不截断纵向滚动链。Radix 的状态控件和 Popover、DropdownMenu 等触发器不直接作为 TooltipTrigger 的 `asChild` 子组件；用无外观包装元素承接 Tooltip 的 `data-state`，保留控件自己的选中或展开状态。相关组合由 `tests/architecture-boundaries.test.mjs` 检查。
- 表单、弹窗和脚本工作区等通用滚动区域复用 `ScrollArea`，业务内容的内边距放在 `contentClassName` 或滚动内容层，不通过 Viewport 样式覆盖统一留白；外层有内边距时，将滚动区延伸至容器外沿，保留内容的对齐和间距；消息、代码、表格和编辑器等组件自管滚动时沿用全局滚动条样式。`TooltipButton` 默认用于图标，带文字的调用显式选择 `size="sm"` 或 `size="default"`。
- TypeScript 优先具体类型或 `unknown`，类型导入使用 `import type`；避免深层条件与无必要抽象，保持既有状态与 API 边界。
- 复用主题、Tailwind 工具类和组件公开 API，保持键盘操作、语义化标签、焦点及错误反馈；不为单页需求将业务逻辑塞进通用组件。
- 纵向表单字段复用 `LabeledField` 或 `ui/field`，字段组明确保留行列间距、窄屏排列和 `min-w-0`，不依赖行内 `label` 的 `space-y-*`。列表和表格排序统一复用 `SortableList`、`SortableItem`、`SortableHandle`，保留拖动让位、键盘排序、禁用状态和减少动态效果设置；文件投放与画布坐标拖动沿用各自的交互组件。
- 完成前执行 `npm run build`（包含类型检查）和 `npm run lint`。现有回归位于 `tests/`，通过 `bun test tests/<相关文件>.test.mjs` 或现有 `npm run test` 脚本执行。
- 行为变更补对应回归，优先扩展已有测试；纯样式布局不增加只绑定类名的测试，不擅自引入 UI 测试框架。视觉验证复用现有 Vite 服务，截图放 `assets/`。
