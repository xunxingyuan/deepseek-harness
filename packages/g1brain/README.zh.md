---
description: "G1brain 包组：连接本体与文档资源的宿主集成，供资产选择及限定范围的 Harness 会话使用。"
kind: "package-group"
---

# g1brain/ — 本体与文档集成

[English](README.md) | 中文

## 概要

`g1brain/` 包组把桌面工作台和 Harness 会话连接到 G1brain 本体与文档资源。使用集成包可发现已有集合与文档库、检索其中的内容，或在选定会话目标范围内工作。浏览器界面由单独的 [G1brain 工作台界面](../client/ui-g1brain/README.zh.md)负责。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发记录](#dev-note)

-----

<a id="packages"></a>
## 包列表

宿主集成是本组唯一的包；其 README 负责后端与会话工具的行为说明。

| 包 | 职责 |
|---|---|
| [`integration/`](integration/README.zh.md) | 提供 G1brain 目录、发现与搜索工具，以及所选会话范围内的本体和文档操作 |

<a id="related-documentation"></a>
## 相关文档

- [G1brain 工作台界面](../client/ui-g1brain/README.zh.md) — 浏览器端资产选择与会话准备。
- [桌面应用](../../apps/desktop/README.zh.md) — 配置档案启用和打包运行时行为。

<a id="dev-note"></a>
## 开发记录

无。
