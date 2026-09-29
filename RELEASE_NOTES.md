# v3.0.16

## 版本概览

新增 RunningHub 工作流接入，补充 Grok/Gemini 接口文档，并修复模型识别和 Firefox 数字输入显示问题。

## 新增功能

- 自定义 API 配置支持 RunningHub 图片、视频和音频工作流协议。
- 新增 RunningHub 工作流元数据读取、字段映射、参数校验和执行支持，并提供协议测试覆盖。
- 补充 Grok、Gemini 官方生图接口、NewAPI 请求格式和项目参数映射文档。

## 功能改进

- RunningHub 工作流配置增加协议选择、基础地址和 API Key 使用说明，并接入配置页工作流目录读取。
- 数字输入框统一隐藏 Firefox 和 Chromium 原生上下旋钮，保留应用内自定义加减控件。

## 问题修复

- 修复 MiniMax M2.5 等语言模型被误识别为视频模型的问题，同时保留 MiniMax H3 视频模型识别。
- 修复 Firefox 数字输入控件原生旋钮挤压输入数字、导致生成数量不可见的问题。
- 增加 RunningHub 元数据接口的认证、协议校验和 API Key 脱敏测试。

## 移除与调整

- 无
