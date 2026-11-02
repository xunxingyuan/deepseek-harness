---
kind: upgrade-guide
description: G1brain 细粒度创建拒绝不安全的新 SID，创建关系边必须引用已有关系 SID。
---

# G1brain SID 规则

[English](guide.md) | 中文

## 变更

G1brain 创建类、个体、属性和关系类型时，原先接受任意非空 SID，现在要求匹配 `^[A-Za-z][A-Za-z0-9_]*$`。创建关系边必须使用生效关系定义的准确 SID，工具会按网页规则使用其显示名作为边标签。缺失定义、标签歧义、标签含点号或控制字符时，在写入前拒绝请求；不会更换标签重试。

## 迁移

1. 调整创建脚本和指令，使用 `Instrument`、`belongs_to_unit` 等标识，不拼接集合或领域前缀；中文名称保存在 `displayName`。
2. 查询、更新和引用时保留已有实体、属性和关系 SID，不去掉点号或更改已存标识。创建关系前查询 `g1brain_list_ontology_relation_definitions`，将准确 SID 填入 `relationSid`，不要传显示名。
3. 创建关系边前解决显示名重名或不可用标签，通过 `g1brain_get_ontology_relations` 回读验证写入结果。

不自动迁移已有会话绑定或图谱。本体包构件 ID 仍遵循服务端包格式，不会被本次变更改写。
