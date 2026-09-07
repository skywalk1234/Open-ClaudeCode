# Taste
- 使用简体中文沟通；期望助手用中文回复，代码/命令本身保留英文。Confidence: 0.9
- 模型接入偏好 DeepSeek：通过 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`）使用 `deepseek-v4-flash`，key 与模型别名配置在 `~/.claude/settings.json`（用 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`），而非环境变量。Confidence: 0.8
- 倾向复用现有本地配置：当配置已生效且验证通过时，偏好不重复改动文件、直接告知"已就绪"并说明验证结果。Confidence: 0.6
- UI 审美偏好 Claude 风格暖色浅橙主题：象牙白背景（如 #FAF9F5）、暖沙色面板（#F0EEE6）、陶土橙点缀（#D97757），温暖浅色系而非深色主题。Confidence: 0.8
- 聊天类前端期望真实的 token 流式输出：逐增量渲染文本、思考过程和工具参数，而非只显示完整消息。Confidence: 0.75
- 后台服务的启停由用户自己掌控：助手为验证/测试临时启动的 server（如 dev server）任务完成后应主动停掉并释放端口，交由用户自行启动运行，而非留在后台替用户维护。Confidence: 0.65
