---
description: "桌面工作台使用的 G1brain 宿主目录服务及限定会话范围的本体、文档工具。"
kind: "package-reference"
---

# G1brain 集成

[English](README.md) | 中文

## 概述

桌面配置默认启用此宿主插件。它向工作台提供本体集合、领域和文档库目录。目录响应保留 API 名称和可选显示名；工作台优先展示易读名称，会话绑定仍使用 API 名称。任意普通桌面会话可使用 16 个只读发现与检索工具。新准备的 G1brain 会话会先绑定所选目录、本体集合与领域、文档库，再向该会话智能体提供完整的 46 个本体和文档工具。访问令牌只保存在宿主进程中。

## 目录

- [使用](#use-this-package)
- [理解此包](#understand-the-package)
- [延伸阅读](#further-reading)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用

本地开发桌面版或带有明确标记的未签名测试安装包会提供 `G1BRAIN_BASE_URL`（`http://192.168.100.113:19091`）、`G1BRAIN_LOCAL_USER_ID`（`developer`）、`G1BRAIN_LOCAL_CLIENT_ID`（`g1brain-web`）、`G1BRAIN_ALLOW_LOCAL_DEV=1` 和 `G1BRAIN_ALLOW_DEV_WRITES=1`；环境变量可覆盖这些默认值。宿主会沿用旧客户端的 `X-User-Id`、`X-Client-Id` 请求头；此测试身份与登录时输入的用户名无关。开发和未签名测试配置均启用写入，并不代表登录用户的真实授权。其他部署须自行配置服务地址和认证参数。OAuth 模式需设置 `G1BRAIN_ACCESS_TOKEN` 与 `G1BRAIN_CLIENT_SECRET`（可选设置 `G1BRAIN_CLIENT_ID`）；宿主会发送 Basic 认证与 `Blade-Auth`。`G1BRAIN_TENANT_ID` 默认是 `000000`。没有对应认证参数时，插件仍启用但报告 `configured: false`，目录调用会明确报错。桌面登录暂未向宿主服务传递登录身份或 OAuth 令牌。

工作台为新的顶层会话调用 `bindSession`。宿主校验所选目录就是该会话的工作区，并将完整目标保存于仅所有者可读写的私有绑定文件。46 个工具只安装在对应智能体范围；恢复智能体时重新读取绑定。工具执行时再次检查会话、目标、原始输入结构和目录范围。写入必须提供 `confirm=true`。7 种新增类工具各自在首次调用时请求用户授权：同一种工具在当前绑定会话内最多复用 100 次、有效 30 分钟；重启宿主后失效，换一种新增工具则重新询问。更新、删除、上传、文档处理任务提交/取消和整包导入仍逐次审批。上传还须明确列出文件并逐一预检路径。旧版的 5 个智能体管理工具有意不开放。

文档处理沿用当前 G1brain 网页的 MD 接口：上传后先提交 `MD` 切片任务并确认成功，再提交 `CHUNK` 的关键词、向量化和索引操作。提交工具可选择绑定文档库内的全部现有文件，也可指定经过该库校验的文档 ID。7 个任务工具覆盖提交、当前/历史列表、详情、逐文件状态、限时等待与取消。列表和详情只返回摘要，避免大型任务占满模型上下文。

绑定存储在 POSIX 上检查私有目录权限；Windows 依赖当前用户配置目录的 ACL，不以合成的 POSIX 权限位判断。目录匹配采用对应平台的路径比较规则，包括 Windows 盘符大小写。恢复智能体时若无法读取绑定或材料目录，会使初始化失败，而非悄悄退回只读工具。

未绑定的普通会话可列出本体集合、领域、分类树节点、属性、关系定义与类型、实体和关系边；也可列出文档，执行混合检索、QA 检索、片段定位与片段列表查询。只有这些明确列出的只读工具全局开放；输入会校验，返回文本最多 32 KiB，超出时附截断提示。它们使用宿主配置的 G1brain 身份，而非桌面登录时经服务端验证的用户身份。

<a id="understand-the-package"></a>
## 理解此包

宿主插件负责服务凭据、资源目录、持久会话绑定和逐次授权。客户端页面调用其目录及绑定方法；普通会话只获得全局只读工具。

<a id="further-reading"></a>
## 延伸阅读

- [G1brain 工作台界面](../../client/ui-g1brain/README.zh.md)
- [桌面版设置](../../../apps/desktop/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 工作流指引

#### 模型看到的内容

固定的 `g1brain:workflow` 系统段加入以下文本。[录制的系统提示](../../../snapshots/session/g1brain-session-guidance/system-prompt.expected.md) 验证其插入位置。

##### 工作流指令

```markdown
## G1brain workflow

Reply in the language of the current user request, including progress updates, clarification questions, and the final result. Use Simplified Chinese for Chinese requests unless the user explicitly asks for another language.

Use the available G1brain tools for ontology and document operations. Ordinary Sessions provide discovery and search; creation and updates require a G1brain build or improvement Session prepared with the selected ontology, domain, document library, and source folder.

If write tools are absent, explain that this Session is read-only and direct the user to prepare a G1brain build or improvement Session. Do not interpret missing write tools as missing API credentials or ask the user to install another plugin.

In a prepared Session, inspect the sources, propose a plan, and use the bound G1brain tools after the user approves the plan. Tool approval remains required for writes.
```

#### Token 影响

配置完成的集成会在每次智能体请求中加入这段固定内容，不随资源目录大小变化。

#### KV Cache 影响

普通会话与准备会话使用相同段落；更新或启用集成时，其文本会改变系统前缀。

### 目录与绑定会话工具

#### 模型看到的内容

配置 API 凭据后，每个智能体可见 16 个 G1brain 资源发现与文档检索只读工具，包括 `g1brain_list_ontology_domains` 和 `g1brain_hybrid_search`。两个全局顶层目录工具只返回名称；其他全局查询返回有长度限制的文本。绑定会话还可见 46 个限定范围的所选文件、文档库、文档处理任务、检索、本体实体、关系、属性、关系类型及包校验/导入工具，其中目录工具可返回完整后端记录。未绑定会话看不到这些限定范围的工具；关闭写入时，写入工具不会出现。结果以普通文本显示在会话中。

#### Token 影响

每个可见工具都会在请求中增加固定定义。普通会话现在包含 16 个 G1brain 只读工具定义；绑定会话的前缀明显更长。调用返回的数据会再增加结果文本，全局查询结果设有上限。

#### KV Cache 影响

同一普通或绑定会话内的定义保持稳定；绑定会话或调整写入策略会改变其提示前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 开发模式登录不校验身份，也不授予后端写入权限。`developer` 是共享测试身份；仅应在开发服务使用，仔细核对首次授权内容。
- 重复新增授权限定为同一种工具和绑定会话，但宿主无法判断模型后续生成的每条记录是否符合已审核方案。如发现内容偏离，应停止本轮执行。
- 提交文档任务只会安排服务端处理，并不会立即使文档可检索。须通过详情或等待工具确认 `SUCCESS` 后，才能认为切片或索引就绪。任务接口以当前 G1brain 网页为依据；插件未开放任务删除和清理。
- 会话绑定后目标固定；切换资源需要新建会话。全局发现与检索工具可查询宿主配置身份能够访问的任意集合，但不能修改数据。
- 通过环境变量提供的 OAuth 凭据尚未与其他宿主插件及未来子进程隔离；在实现专用凭据传递前只能使用开发凭据。

<a id="dev-note"></a>
### 开发备注

无。
