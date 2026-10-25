# Contributing

Use a small, focused pull request. Describe the behavior changed and the checks you ran.

~~~powershell
cd runtime
npm ci
npm run build
npx tsx --test src/forge-deployment.test.ts
~~~

Do not include tokens, private projects, browser profiles or machine-specific configuration. Preserve license notices and test the entrypoint users will run.
