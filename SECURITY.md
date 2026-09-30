# Security

Please report suspected vulnerabilities privately to **jiaweizhang1122@gmail.com**. Include the version, affected feature and a minimal reproduction with redacted credentials. Do not post API keys, private passages or personal browser data in public issues.

The latest tagged release is the supported version. There is no guaranteed response time or security warranty.

API keys are stored in local extension storage, not an encrypted OS keychain. They are sent directly to the user-configured endpoint. Only configure providers and proxies you trust. Model/search requests can send selected text, enabled context or search passages to those providers. For details, see `public/privacy.html` and the in-extension guide.

If a key is exposed, revoke it through its provider and replace it locally. Never include a real key in a bug report or pull request.
