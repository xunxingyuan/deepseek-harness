---
kind: upgrade-guide
description: G1brain document uploads retain pictures and require genuine OAuth credentials instead of silently dropping images.
---

# G1brain document pictures and login expiry

English | [中文](guide.zh.md)

## Change

Document uploads preserve DOCX body pictures, XLSX worksheet pictures and local Markdown image references through the existing static-resource service. Uploads with pictures now require a genuine G1brain OAuth token and authenticated user ID. Unsupported images, missing local files, escaped paths and unusable static URLs fail before that document's Markdown is submitted. Legacy XLS pictures require conversion to XLSX. Existing documents are not rewritten automatically.

Desktop OAuth sign-in replaces the Host with the current process-local credential. Expiry or authenticated HTTP/business 401 returns to Welcome and stops subsequent authenticated operations; no additional confirmation is required. Local files and conversations remain. Development sign-in still does not authenticate against G1brain and supplies no static-resource token.

## Migration

1. In Desktop Welcome's Connection settings, configure the service addresses, client ID and client secret, then sign in with G1brain. Saving a secret enables OAuth. Blank keeps the configured secret; it is OS-encrypted and never echoed. Legacy URL-only preferences remain readable; copying encrypted preferences to another device/account may require reconfiguration. Secrets are not embedded in installers. External deployments can still use OAuth environment configuration; a standalone Host also needs `G1BRAIN_USER_ID` for pictures.
2. Configure the integration's `resourceCategoryId` if its picture category differs from the existing root `11`. The resource service must return permanent, anonymously readable same-origin paths; tokens are never added to image URLs. Use only material approved for that server's static-access policy.
3. Save picture-bearing XLS files as XLSX. Convert unsupported image formats to PNG/JPEG/GIF/WebP/BMP; use standard Markdown image syntax for local references. Select a vector library for picture notes even if Excel data routes to tables.
4. Re-import original sources when repairing older image-free documents, and check for existing document records before retrying. Image-aware imports do not reuse old text-only receipts; accepted pictures can remain after a later document failure and are never deleted automatically.
