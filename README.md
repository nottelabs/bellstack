# Bell on Notte

<p align="center"> <img width="128" height="128" alt="BELL" src="https://github.com/user-attachments/assets/f4c9363d-2ab0-4205-a3c7-7d7ad61ec6c6"/> <img width="128" height="128" alt="Notte" src="docs/assets/notte-satin-silver.png"/></p>

Bell on Notte is a reference architecture and sample app for building personal AI assistants that execute tasks on your behalf. Notte provides browser infrastructure by default; Stagehand controls the browser.

On [BrowserArena](https://browserarena.ai), Notte is 12x cheaper and 8x faster than Browserbase.

- Notte: Browser + Stagehand
- Eve by Vercel: Agent Framework
- Link by Stripe: Payments
- Linq: Messaging Infrastruture
- 1Password: Authentication
- Baselayer: Identity


## Run locally

Requires Node.js 24, pnpm 10.33.4, and OpenAI and Notte API keys.

```sh
git clone git@github.com:nottelabs/bellstack.git
cd bellstack
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `OPENAI_API_KEY` and `NOTTE_API_KEY` in `.env`. For ordinary browsing, set `BELL_DEMO_URL` to your target website.
Hosted sessions use Notte by default. Local Chrome requires `STAGEHAND_BROWSER=local`.

```sh
pnpm dev
```


## Start here

| Integration | What it does | Guide |
| --- | --- | --- |
| Notte + Stagehand | Browser sessions, automation, saved Contexts, and human handoff | [Browser runtime](docs/browser-runtime.md) |
| Eve by Vercel | Agent configuration, tools, conversation state, and channels | [Eve in Bell](docs/repository.md#eve-by-vercel) |
| Linq | iMessage and SMS through a signed webhook and sender allowlist | [Messaging setup](docs/linq.md) |
| Link by Stripe | Wallet authorization, spend approval, and checkout through Linq | [Sandbox and wallet setup](docs/link.md) |
| 1Password | Operator credentials and OTP; personal Agentic Autofill is disabled by default | [Operator access](docs/browser-runtime.md#credentials-and-otp) · [Personal access status](docs/onepassword.md) |
| Baselayer | Verified access to approved merchants using short-lived credentials | [Merchant access](docs/baselayer.md) |


See the [repository layout and implementation map](docs/repository.md) to extend Bell.



## Development

```sh
pnpm check
```

Runs tests, type checking, lint, and the production build. [Live provider checks](docs/provider-tests.md) are opt-in.

Notte records hosted sessions and network activity by default. Credential tools use these defaults
without an additional recording opt-in. Personal 1Password Autofill remains disabled.

Bell is a sample app for one trusted operator. Before deploying, configure application authentication and durable storage using the [browser runtime guide](docs/browser-runtime.md).


## License

Based on the original Bell sample app by Browserbase. The [MIT license](LICENSE) retains Browserbase's original copyright notice and adds Notte's for its modifications.
