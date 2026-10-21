# 独立后台简化审查（2026-10-21）

参考项目：
- Langfuse：https://github.com/langfuse/langfuse 。Token/成本文档：https://github.com/langfuse/langfuse-docs/blob/main/content/docs/observability/features/token-and-cost-tracking.mdx 。重点是调用级用量、缓存分项互斥和缺失计量。
- LiteLLM：https://github.com/BerriAI/litellm 。用量文档：https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/cost_tracking.md 。重点是按用户、模型统计账本。

本轮不引入以上项目或任何依赖，只比较相关的数据边界。

已修复 public/app.js：
1. 首次接口失败时 snapshot 为空，原自动刷新条件永远为假，服务恢复也不重连。现在允许空快照时每 5 秒重试。
2. fetch 无超时可能让 loading 一直为真，所有刷新被跳过。现有统一 api 函数增加 20 秒超时，失败由 finally 释放刷新状态。
3. 用户详情请求期间保留上次 userDetailData，点击旧标签可能展示上一用户。现在立即清空并显示加载状态，继续用已有版本号和弹窗关闭校验丢弃迟到结果。
4. 快照刷新失败时保留旧画面但没有明确标注，可能将旧累计值误认为实时结果。现在连接失败显示过期数据提示并暂停导出，成功后恢复。

验证：脚本语法；既有两项服务测试通过；隔离内存手动验证用户切换/关闭弹窗迟到响应；真实用户 API 返回 200。未调用收费模型，真实视频成功输出后的累计仍待实际生成验收。

保留的边界：未知 Token 不推算；视频数量从 outputCount 聚合；历史没有输出数量的成功调用不填造数据；不采集创作正文。大账本下多个聚合查询的耗时仍需真实负载验证；本轮没有引入缓存、队列或数据库替换。
