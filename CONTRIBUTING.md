# Contributing

Bug reports, documentation corrections and pull requests are welcome.

1. Fork the repository and create a branch for your change.
2. Use Node.js 24+, run `npm ci`, then `npm run build`.
3. Run `npm run typecheck` and `npm test`. For UI/interaction changes, install Chromium with `npx playwright-core install chromium` and run the relevant `test:*` browser scripts in package.json.
4. Describe the problem, resulting behavior and checks in your pull request. Add meaningful regression coverage for behavior changes.

Keep Chinese and English interface strings consistent. Do not translate user content, replace saved API keys, or overwrite custom prompts when changing defaults. Include nearby-context and data-sending behavior in reviews of model features.

Place generated releases in `releases/`, test output in `test-results/`, and local working files in `work/`. Do not commit those directories, private artwork, credentials, `.env` files or browser profiles. Browser tests use disposable system temporary profiles and simulated API responses. Real-service probes are optional, incur provider charges and must never receive committed keys.

By contributing, you agree that your original contributions may be distributed under this project's MIT license. Preserve upstream notices for third-party code and assets.
