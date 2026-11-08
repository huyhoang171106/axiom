# Hướng dẫn: Kết nối provider và chọn model

Người làm phần provider, model, đăng nhập và cost phải tuân theo file này. Thiết kế lấy theo [oh-my-pi](https://github.com/can1357/oh-my-pi) (đọc ở commit `c3b645c`, 28/10/2026): `docs/providers.md`, `docs/models.md`, `docs/adding-a-provider.md`, `docs/secrets.md`, và catalog `packages/catalog/src/compat/rules/{providers,auth}/*.kdl`.

Owner: **B** (catalog, credential + refresh, đăng nhập API key, cloud, device code, model resolver). **C** engine `oauth-code` và 9 luồng của nó. **A** engine `hook` (`openai-codex-device`, `github-copilot`, `cursor`). Wire mới: **A** họ OpenAI + `factory`/`gitlab-duo`, **E** họ Google, **D** Ollama/Bedrock và `cursor`/`devin` (xem `docs/plans/phase-1-{A,B,C,D,E}.md`). **A** gán model theo role cho từng UC. **E** hiển thị cost trên footer.

**Cách dùng file này.** File này là hướng dẫn bắt buộc cho người và cho AI coding assistant viết code phần provider.
- Đọc hết file trước khi viết code.
- Làm theo đúng thứ tự các bước ở mục 12. Mỗi bước là một commit. Bước sau chỉ bắt đầu khi test của bước trước pass.
- "PHẢI" và "KHÔNG ĐƯỢC" là luật. Muốn làm khác thì ghi vào "Nhật ký quyết định" trong `docs/DESIGN.md` và hỏi owner trước.
- Code có sẵn thì mở rộng, không viết lại. `src/core/types.ts` đã có `ModelRole`, `modelRoles`, `CustomModelInfo`, `ProviderCredentials`. `src/llm/providers/openai.ts` và `anthropic.ts` là 2 wire đã có.

> **Quy tắc bản quyền.**
> - Không chép code của oh-my-pi.
> - **Được** lấy dữ kiện công khai (ID, tên biến môi trường, base URL, model mặc định, cách đăng nhập) vì đó là thông tin của provider, không phải code. Ghi nguồn "oh-my-pi catalog, MIT" trong mục "Minh bạch sử dụng AI và trích dẫn" của báo cáo.
> - Axiom tự viết lại cấu trúc bằng JSON và TypeScript (mục 7), không dùng KDL.

## 1. Khái niệm

| Từ | Nghĩa | Ví dụ |
|---|---|---|
| Provider | Một backend hoặc một tài khoản | `anthropic`, `openrouter`, `zai`, `ollama` |
| Model | Một model cụ thể của provider | `glm-5.3` |
| Selector | Cách viết để chọn model: `provider/model-id` | `openrouter/qwen/qwen3-coder` |
| Wire | Giao thức HTTP mà provider dùng. Một wire phục vụ nhiều provider | `openai-completions`, `anthropic-messages` |
| Role | Vai trò công việc, mỗi role trỏ tới một selector | `default`, `smol`, `slow`, `plan`, `review` |
| Cách kết nối | Cách lấy credential (mục 4) | API key, subscription, OAuth, cloud, local |
| Available | Provider không bị tắt **và** (không cần key **hoặc** đã có credential) | |

Kiểm tra "available" là kiểm tra cấu hình, nhanh, **không gọi mạng**. Key sai vẫn hiện là available, và sẽ báo lỗi khi gọi model.

## 2. Luồng dữ liệu

```
 src/llm/catalog/providers/*.json ──┐                          ┌── ~/.axiom/models.json (provider tự thêm)
 src/llm/catalog/auth/*.json ───────┼──► [Catalog] ◄───────────┤
 ~/.axiom/models-cache.json ────────┘        │                 └── discovery GET /models (khi /model, models refresh)
                                             │ danh sách provider + model
                                             ▼
 --api-key ─────────┐                  [resolveModel("@smol")] ◄── modelRoles (~/.axiom/config.json)
 models.json apiKey ┤                        │ ModelInfo {provider, id, api, baseUrl, contextWindow, cost}
 auth.json (login) ─┼──► [resolveCredential] ┤
 biến môi trường ───┤        │ credential    ▼
 ~/.axiom/.env ─────┘        └──────► [wire theo ModelInfo.api] ──► HTTP tới provider
                                             │
                                             ▼ usage (token, cost)
                                      CostTracker ──► footer, trace
```

## 3. Danh sách provider (giống oh-my-pi)

**91 provider ID**: 89 provider trong catalog của oh-my-pi và 2 biến thể đăng nhập (`openai-codex-device`, `zai-coding-plan`). Thứ tự theo bảng chữ cái. Thứ tự trong `/login` ở mục 10.

| Cách kết nối | Số provider |
|---|---|
| API key | 43 |
| Subscription (key của gói) | 17 |
| Subscription OAuth | 12 |
| Local (không cần key) | 7 |
| Cloud credentials | 5 |
| Model phán đoán (judge), không phải chat | 2 |
| API key + Subscription OAuth (Claude Pro/Max) | 1 |
| Personal Access Token hoặc OAuth app của chính bạn | 1 |
| Subscription (key của gói) + Subscription OAuth (device) | 1 |
| OAuth cho app bên thứ ba + API key | 1 |
| OAuth local app của Snowflake hoặc PAT | 1 |

| Trong Axiom | Số provider |
|---|---|
| Làm | 87 |
| Không làm | 4 |

Cột "Trong Axiom":
- **Làm**: làm hết trong Phase 1. Nếu ghi "(cần wire X)" thì phải làm wire X (mục 6) để provider chạy được.
- **Không làm**: có lý do ở mục 4.7. Vẫn phải có file JSON với `"available": false` để `/login` hiện lý do thay vì báo "không tìm thấy".

| # | ID | Tên | Cách kết nối | Biến môi trường | Wire | Base URL | Model mặc định | Trong Axiom |
|---|---|---|---|---|---|---|---|---|
| 1 | `abliteration` | Abliteration | API key | `ABLITERATION_API_KEY`, rồi `ABLIT_KEY` | `openai-responses` | `https://api.abliteration.ai/v1` | `abliterated-model` | Làm (cần wire `openai-responses`) |
| 2 | `aiand` | ai& | API key | `AIAND_API_KEY` | `openai-completions` | `https://api.aiand.com/v1` | `moonshotai/kimi-k2.7-code` | Làm |
| 3 | `aimlapi` | AIML API | API key | `AIMLAPI_API_KEY` | `openai-completions` | `https://api.aimlapi.com/v1` | `gpt-5.5-2026-04-23` | Làm |
| 4 | `alibaba-coding-plan` | Alibaba Coding Plan | Subscription (key của gói) | `ALIBABA_CODING_PLAN_API_KEY` | `openai-completions` | `https://coding-intl.dashscope.aliyuncs.com/v1` | `qwen3.7-plus` | Làm |
| 5 | `alibaba-token-plan` | QwenCloud Token Plan | Subscription (key của gói) | `ALIBABA_TOKEN_PLAN_API_KEY`, rồi `BAILIAN_TOKEN_PLAN_API_KEY` | `openai-completions` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | `qwen3.7-plus` | Làm |
| 6 | `amazon-bedrock` | Amazon Bedrock | Cloud credentials | `AWS_BEARER_TOKEN_BEDROCK`, AWS profile, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, hoặc credential chain ECS/IRSA/EC2 | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `us.anthropic.claude-opus-5-5` | Làm (cần wire `bedrock-converse-stream`) |
| 7 | `anthropic` | Anthropic (Claude Pro/Max) | API key + Subscription OAuth (Claude Pro/Max) | `ANTHROPIC_OAUTH_TOKEN`, rồi `ANTHROPIC_API_KEY` | `anthropic-messages` | `https://api.anthropic.com` | `claude-opus-5-5` | Làm |
| 8 | `apple` | Apple Foundation Models (on-device) | Local (không cần key) | — | `apple-foundation-models` | `(trên máy macOS)` | `on-device` | Không làm — cần runtime native (local) / chỉ macOS (apple) |
| 9 | `azure` | Azure OpenAI | Cloud credentials | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_RESOURCE_NAME` (hoặc `AZURE_OPENAI_BASE_URL`), tùy chọn `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | `azure-openai-responses` | `https://<resource>.openai.azure.com/openai/v1` | `gpt-5.5` | Làm (cần wire `azure-openai-responses`) |
| 10 | `baseten` | Baseten | API key | `BASETEN_API_KEY` | `openai-completions` | `https://inference.baseten.co/v1` | `moonshotai/Kimi-K2.7-Code` | Làm |
| 11 | `bedrock-mantle` | Amazon Bedrock Mantle | Cloud credentials | `AWS_BEARER_TOKEN_BEDROCK` hoặc AWS credential chain (SigV4) | `openai-responses` | `https://bedrock-mantle.{region}.api.aws/openai/v1` | `openai.gpt-5.6-terra` | Làm (cần wire `openai-responses`) |
| 12 | `cerebras` | Cerebras | API key | `CEREBRAS_API_KEY` | `openai-completions` | `https://api.cerebras.ai/v1` | `zai-glm-4.7` | Làm |
| 13 | `charm-hyper` | Charm Hyper | API key | `CHARM_HYPER_API_KEY`, rồi `HYPER_API_KEY` | `openai-completions` | `https://hyper.charm.land/v1` | `glm-5.3` | Làm |
| 14 | `cline-pass` | ClinePass | Subscription (key của gói) | `CLINE_API_KEY` | `openai-completions` | `https://api.cline.bot/api/v1` | `kimi-k3` | Làm |
| 15 | `cloudflare-ai-gateway` | Cloudflare AI Gateway | Cloud credentials | `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` | `anthropic-messages` | `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` | `anthropic/claude-opus-5` | Làm |
| 16 | `cloudflare-workers-ai` | Cloudflare Workers AI | Model phán đoán (judge), không phải chat | `CLOUDFLARE_API_TOKEN`, rồi `CLOUDFLARE_AUTH_TOKEN`, + `CLOUDFLARE_ACCOUNT_ID` | `workers-ai-systemone` | `https://api.cloudflare.com/client/v4/accounts/<account>/ai/run` | `@cf/cloudflare/clef` | Không làm — không dùng cho chat |
| 17 | `commandcode` | Command Code | API key | `COMMAND_CODE_API_KEY`, rồi `COMMANDCODE_API_KEY` | `openai-completions` | `https://api.commandcode.ai/provider/v1` | `claude-sonnet-5` | Làm |
| 18 | `coralbricks` | CoralBricks | API key | `CORAL_API_KEY`, rồi `CORALBRICKS_API_KEY` | `openai-completions` | `https://inference.coralbricks.ai/v1` | `glm-5.3-fast` | Làm |
| 19 | `coreweave` | CoreWeave Serverless Inference | API key | `COREWEAVE_API_KEY`, rồi `WANDB_API_KEY` | `openai-completions` | `https://api.inference.wandb.ai/v1` | `openai/gpt-oss-120b` | Làm |
| 20 | `cursor` | Cursor (Claude, GPT, etc.) | Subscription OAuth | `CURSOR_ACCESS_TOKEN` | `cursor-agent` | `https://api2.cursor.sh` | `claude-opus-5-high` | Làm (cần wire `cursor-agent`) |
| 21 | `deepinfra` | DeepInfra | API key | `DEEPINFRA_API_KEY` | `openai-completions` | `https://api.deepinfra.com/v1/openai` | `deepseek-ai/DeepSeek-V4-Flash-0731` | Làm |
| 22 | `deepseek` | DeepSeek | API key | `DEEPSEEK_API_KEY` | `openai-completions` | `https://api.deepseek.com` | `deepseek-v4-pro` | Làm |
| 23 | `devin` | Devin | Subscription OAuth | `DEVIN_API_KEY` | `devin-agent` | `https://server.codeium.com` | `swe-1-6` | Làm (cần wire `devin-agent`) |
| 24 | `factory-droid` | Factory Droid | Subscription OAuth | không có — chỉ `/login` | `factory-droid-agent` | `https://api.factory.ai` | `kimi-k3` | Làm (cần wire `factory-droid-agent`) |
| 25 | `firepass` | Fire Pass (Fireworks subscription) | Subscription (key của gói) | `FIREPASS_API_KEY` | `openai-completions` | `https://api.fireworks.ai/inference/v1` | `glm-5.2-fast` | Làm |
| 26 | `fireworks` | Fireworks | API key | `FIREWORKS_API_KEY` | `openai-completions` | `https://api.fireworks.ai/inference/v1` | `kimi-k3` | Làm |
| 27 | `github-copilot` | GitHub Copilot | Subscription OAuth | `COPILOT_GITHUB_TOKEN` | `openai-responses` | `https://api.githubcopilot.com` | `gpt-5.5` | Làm (cần wire `openai-responses`) |
| 28 | `gitlab-duo` | GitLab Duo Non-Agentic | Personal Access Token hoặc OAuth app của chính bạn | `GITLAB_TOKEN` | `anthropic-messages` | `https://cloud.gitlab.com/ai/v1/proxy/anthropic/` | `duo-chat-opus-4-6` | Làm |
| 29 | `gitlab-duo-agent` | GitLab Duo Agent | Subscription OAuth | `GITLAB_TOKEN` | `gitlab-duo-agent` | `https://gitlab.com` | `claude_sonnet_4_6_vertex` | Làm (cần wire `gitlab-duo-agent`) |
| 30 | `gmi-cloud` | GMI Cloud | API key | `GMI_API_KEY` | `openai-completions` | `https://api.gmi-serving.com/v1` | `deepseek-ai/DeepSeek-V4-Flash` | Làm |
| 31 | `google` | Google Gemini | API key | `GEMINI_API_KEY` | `google-generative-ai` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.1-pro-preview` | Làm (cần wire `google-generative-ai`) |
| 32 | `google-antigravity` | Google Antigravity (Gemini, Claude, GPT-OSS) | Subscription OAuth | — | `google-gemini-cli` | `https://daily-cloudcode-pa.googleapis.com` | `gemini-3.1-pro` | Làm (cần wire `google-gemini-cli`) |
| 33 | `google-gemini-cli` | Google Cloud Code Assist (Gemini CLI) | Subscription OAuth | — | `google-gemini-cli` | `https://cloudcode-pa.googleapis.com` | `gemini-3.1-pro-preview` | Làm (cần wire `google-gemini-cli`) |
| 34 | `google-vertex` | Google Vertex AI | Cloud credentials | `GOOGLE_CLOUD_API_KEY`, hoặc ADC (`GOOGLE_APPLICATION_CREDENTIALS`) + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` | `google-vertex` | `https://{location}-aiplatform.googleapis.com` | `gemini-3.1-pro-preview` | Làm (cần wire `google-vertex`) |
| 35 | `groq` | Groq | API key | `GROQ_API_KEY` | `openai-completions` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` | Làm |
| 36 | `helmcode` | Helmcode | API key | `HELMCODE_API_KEY` | `openai-completions` | `https://api.helmcode.com/v1` | `deepseek-v4-flash` | Làm |
| 37 | `huggingface` | Hugging Face Inference | API key | `HUGGINGFACE_HUB_TOKEN`, rồi `HF_TOKEN` | `openai-completions` | `https://router.huggingface.co/v1` | `deepseek-ai/DeepSeek-R1` | Làm |
| 38 | `inception` | Inception | API key | `INCEPTION_API_KEY` | `openai-completions` | `https://api.inceptionlabs.ai/v1` | `mercury-3` | Làm |
| 39 | `kilo` | Kilo Gateway | API key | `KILO_API_KEY` | `openai-completions` | `https://api.kilo.ai/api/gateway` | `anthropic/claude-opus-5` | Làm |
| 40 | `kimi-code` | Kimi Code | Subscription (key của gói) + Subscription OAuth (device) | `KIMI_API_KEY` | `openai-completions` | `https://api.kimi.com/coding/v1` | `kimi-for-coding` | Làm |
| 41 | `litellm` | LiteLLM | Local (không cần key) | `LITELLM_API_KEY`, tùy chọn `LITELLM_BASE_URL` | `openai-completions` | `http://localhost:4000/v1` | `claude-opus-5-5` | Làm |
| 42 | `llama.cpp` | llama.cpp (Local OpenAI-compatible) | Local (không cần key) | `LLAMA_CPP_API_KEY` (chỉ khi server bật auth), `LLAMA_CPP_BASE_URL` | `openai-completions` | `http://127.0.0.1:8080/v1` | (model đang nạp trên server) | Làm |
| 43 | `lm-studio` | LM Studio (Local OpenAI-compatible) | Local (không cần key) | `LM_STUDIO_API_KEY` (tùy chọn), `LM_STUDIO_BASE_URL` | `openai-completions` | `http://127.0.0.1:1234/v1` | `llama-3-8b` | Làm |
| 44 | `local` | Local models | Local (không cần key) | — | `local-inference` | `(trong process)` | `lfm2.5-230m` | Không làm — cần runtime native (local) / chỉ macOS (apple) |
| 45 | `meta` | Meta Model API | API key | `MODEL_API_KEY`, rồi `META_API_KEY` | `openai-responses` | `https://api.meta.ai/v1` | `muse-spark-1.1` | Làm (cần wire `openai-responses`) |
| 46 | `minimax` | MiniMax | API key | `MINIMAX_API_KEY` | `anthropic-messages` | `https://api.minimax.io/anthropic` | `MiniMax-M3` | Làm |
| 47 | `minimax-code` | MiniMax Token Plan (International) | Subscription (key của gói) | `MINIMAX_CODE_API_KEY` | `anthropic-messages` | `https://api.minimax.io/anthropic` | `MiniMax-M3` | Làm |
| 48 | `minimax-code-cn` | MiniMax Token Plan (China) | Subscription (key của gói) | `MINIMAX_CODE_CN_API_KEY` | `anthropic-messages` | `https://api.minimaxi.com/anthropic` | `MiniMax-M3` | Làm |
| 49 | `mistral` | Mistral | API key | `MISTRAL_API_KEY` | `openai-completions` | `https://api.mistral.ai/v1` | `devstral-medium-latest` | Làm |
| 50 | `moonshot` | Moonshot (Kimi API) | API key | `MOONSHOT_API_KEY`, rồi `KIMI_API_KEY` | `openai-completions` | `https://api.moonshot.ai/v1` | `kimi-k2.7-code` | Làm |
| 51 | `muse-code` | Muse Code (Subscription) | Subscription OAuth | — | `openai-responses` | `https://api.meta.ai/v1` | `muse-spark-1.3` | Làm (cần wire `openai-responses`) |
| 52 | `nanogpt` | NanoGPT | API key | `NANO_GPT_API_KEY` | `openai-completions` | `https://nano-gpt.com/api/v1` | `openai/gpt-5.5` | Làm |
| 53 | `novita` | Novita | API key | `NOVITA_API_KEY` | `openai-completions` | `https://api.novita.ai/openai/v1` | `moonshotai/kimi-k2.7-code` | Làm |
| 54 | `nvidia` | NVIDIA | API key | `NVIDIA_API_KEY` | `openai-completions` | `https://integrate.api.nvidia.com/v1` | `nvidia/llama-3.1-nemotron-70b-instruct` | Làm |
| 55 | `ollama` | Ollama (Local OpenAI-compatible) | Local (không cần key) | `OLLAMA_API_KEY` (tùy chọn), `OLLAMA_BASE_URL` / `OLLAMA_HOST` | `openai-completions` | `http://127.0.0.1:11434/v1` | `gpt-oss:20b` | Làm |
| 56 | `ollama-cloud` | Ollama Cloud | Subscription (key của gói) | `OLLAMA_CLOUD_API_KEY` | `ollama-chat` | `https://ollama.com` | `gpt-oss:120b` | Làm (cần wire `ollama-chat`) |
| 57 | `openai` | OpenAI | API key | `OPENAI_API_KEY` | `openai-responses` | `https://api.openai.com/v1` | `gpt-5.5` | Làm (cần wire `openai-responses`) |
| 58 | `openai-codex` | ChatGPT Plus/Pro (Codex Subscription) | Subscription OAuth | `OPENAI_CODEX_OAUTH_TOKEN` | `openai-codex-responses` | `https://chatgpt.com/backend-api/codex` | `gpt-6.1-sol` | Làm (cần wire `openai-codex-responses`) |
| 59 | `opencode-go` | OpenCode Go | Subscription (key của gói) | `OPENCODE_API_KEY` | `openai-completions` | `https://opencode.ai/inference/go/v1` | `kimi-k2.7-code` | Làm |
| 60 | `opencode-zen` | OpenCode Zen | Subscription (key của gói) | `OPENCODE_API_KEY` | `openai-completions` | `https://opencode.ai/zen/v1` | `claude-opus-5` | Làm |
| 61 | `openrouter` | OpenRouter | OAuth cho app bên thứ ba + API key | `OPENROUTER_API_KEY` | `openai-completions` | `https://openrouter.ai/api/v1` | `openai/gpt-5.5` | Làm |
| 62 | `qianfan` | Qianfan | API key | `QIANFAN_API_KEY` | `openai-completions` | `https://qianfan.baidubce.com/v2` | `deepseek-v3.2` | Làm |
| 63 | `qwen-portal` | Qwen Portal | Subscription (key của gói) | `QWEN_OAUTH_TOKEN`, rồi `QWEN_PORTAL_API_KEY` | `openai-completions` | `https://portal.qwen.ai/v1` | `coder-model` | Làm |
| 64 | `sakana` | Sakana AI | API key | `SAKANA_API_KEY`, rồi `FUGU_API_KEY` | `openai-responses` | `https://api.sakana.ai/v1` | `fugu` | Làm (cần wire `openai-responses`) |
| 65 | `sambanova` | SambaNova | API key | `SAMBANOVA_API_KEY` | `openai-completions` | `https://api.sambanova.ai/v1` | `gpt-oss-120b` | Làm |
| 66 | `siliconflow` | SiliconFlow | API key | `SILICONFLOW_API_KEY` | `openai-completions` | `https://api.siliconflow.com/v1` | `zai-org/GLM-5.1` | Làm |
| 67 | `siliconflow-cn` | SiliconFlow (China) | API key | `SILICONFLOW_CN_API_KEY` | `openai-completions` | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V4-Pro` | Làm |
| 68 | `singularityapi-dev` | SingularityAPI | API key | `SINGULARITYAPI_DEV_API_KEY` | `openai-completions` | `https://api.singularityapi.dev/v1` | `deepseek-v4-flash` | Làm |
| 69 | `singularityapi-tech` | SingularityAPI Reserved Lanes | API key | `SINGULARITYAPI_TECH_API_KEY` | `openai-completions` | `https://api.singularityapi.tech/v1` | `deepseek-ai/DeepSeek-V4.1-Flash` | Làm |
| 70 | `snowflake` | Snowflake Cortex | OAuth local app của Snowflake hoặc PAT | `SNOWFLAKE_PAT` + `SNOWFLAKE_ACCOUNT` | `anthropic-messages` | `https://snowflake-account.invalid/api/v2/cortex` | `claude-opus-5-5` | Làm |
| 71 | `stepfun` | StepFun | API key | `STEPFUN_API_KEY` | `openai-completions` | `https://api.stepfun.ai/v1` | `step-5-preview` | Làm |
| 72 | `synthetic` | Synthetic | Subscription (key của gói) | `SYNTHETIC_API_KEY` | `openai-completions` | `https://api.synthetic.new/openai/v1` | `hf:zai-org/GLM-5.3-Flash` | Làm |
| 73 | `together` | Together | API key | `TOGETHER_API_KEY` | `openai-completions` | `https://api.together.xyz/v1` | `moonshotai/Kimi-K2.7-Code` | Làm |
| 74 | `typesafe` | TypeSafe | Model phán đoán (judge), không phải chat | `TYPESAFE_API_KEY` | `typesafe` | `https://api.typesafe.ai` | `jev-1.14.0` | Không làm — không dùng cho chat |
| 75 | `umans` | Umans AI Coding Plan | Subscription (key của gói) | `UMANS_AI_CODING_PLAN_API_KEY` | `anthropic-messages` | `https://api.code.umans.ai` | `umans-coder` | Làm |
| 76 | `venice` | Venice | API key | `VENICE_API_KEY` | `openai-completions` | `https://api.venice.ai/api/v1` | `llama-3.3-70b` | Làm |
| 77 | `vercel-ai-gateway` | Vercel AI Gateway | API key | `AI_GATEWAY_API_KEY` (hoặc `VERCEL_AI_GATEWAY_API_KEY`) | `anthropic-messages` | `https://ai-gateway.vercel.sh` | `anthropic/claude-opus-5` | Làm |
| 78 | `vllm` | vLLM (Local OpenAI-compatible) | Local (không cần key) | `VLLM_API_KEY` (tùy chọn), `VLLM_BASE_URL` | `openai-completions` | `http://127.0.0.1:8000/v1` | `gpt-oss-20b` | Làm |
| 79 | `wafer-serverless` | Wafer Serverless (pay-as-you-go) | API key | `WAFER_SERVERLESS_API_KEY` | `openai-completions` | `https://pass.wafer.ai/v1` | `GLM-5.1` | Làm |
| 80 | `xai` | xAI API | API key | `XAI_API_KEY` | `openai-responses` | `https://api.x.ai/v1` | `grok-4.6` | Làm (cần wire `openai-responses`) |
| 81 | `xai-oauth` | xAI Grok OAuth (SuperGrok or X Premium+) | Subscription OAuth | `XAI_OAUTH_TOKEN`, rồi `XAI_API_KEY` | `openai-responses` | `https://api.x.ai/v1` | `grok-4.6` | Làm (cần wire `openai-responses`) |
| 82 | `xiaomi` | Xiaomi MiMo | API key | `XIAOMI_API_KEY` | `openai-completions` | `https://api.xiaomimimo.com/v1` | `mimo-v2.6-flash` | Làm |
| 83 | `xiaomi-token-plan-ams` | Xiaomi Token Plan (Europe) | Subscription (key của gói) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `openai-completions` | `https://token-plan-ams.xiaomimimo.com/v1` | `mimo-v2.6-flash` | Làm |
| 84 | `xiaomi-token-plan-cn` | Xiaomi Token Plan (China) | Subscription (key của gói) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `openai-completions` | `https://token-plan-cn.xiaomimimo.com/v1` | `mimo-v2.6-flash` | Làm |
| 85 | `xiaomi-token-plan-sgp` | Xiaomi Token Plan (Singapore) | Subscription (key của gói) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `openai-completions` | `https://token-plan-sgp.xiaomimimo.com/v1` | `mimo-v2.6-flash` | Làm |
| 86 | `yolo-auto` | Yolo-Auto | API key | `YOLO_AUTO_API_KEY` | `openai-completions` | `https://yolo-auto.com/v1` | `qwen3.8-27b` | Làm |
| 87 | `zai` | Z.AI (GLM Coding Plan) | Subscription (key của gói) | `ZAI_API_KEY` | `anthropic-messages` | `https://api.z.ai/api/anthropic` | `glm-5.3` | Làm |
| 88 | `zenmux` | ZenMux | API key | `ZENMUX_API_KEY` | `openai-completions` | `https://zenmux.ai/api/v1` | `anthropic/claude-opus-5` | Làm |
| 89 | `zhipu-coding-plan` | Zhipu Coding Plan (智谱) | Subscription (key của gói) | `ZHIPU_API_KEY` | `openai-completions` | `https://open.bigmodel.cn/api/coding/paas/v4` | `glm-5.1` | Làm |
| 90 | `openai-codex-device` | ChatGPT Plus/Pro (Codex, headless/device) | Subscription OAuth | — | `openai-codex-responses` | `https://chatgpt.com/backend-api/codex` | `gpt-6.1-sol` | Làm (cần wire `openai-codex-responses`) |
| 91 | `zai-coding-plan` | Z.AI (GLM Coding Plan · Sign in) | Subscription OAuth | — | `anthropic-messages` | `https://api.z.ai/api/anthropic` | `glm-5.3` | Làm |

Các công cụ tìm web cũng nằm trong `/login` của oh-my-pi nhưng **không phải provider model**: `web`, `exa`, `kagi`, `tavily`, `parallel`, `perplexity`. Axiom không làm (đề chỉ cho `fetch_docs` tùy chọn theo allowlist domain).

## 4. Năm cách kết nối

### 4.1. API key (trả theo lượng dùng)

```
 Người dùng        /login (TUI)            Provider API              auth.json
     │ /login deepseek │                         │                        │
     │────────────────►│ hiện link dashboard      │                        │
     │◄────────────────│ + ô nhập che ký tự       │                        │
     │ dán key ───────►│                         │                        │
     │                 │ GET endpoint có bảo vệ ──►│                        │
     │                 │◄──────── 200 / 401 ──────│                        │
     │                 │ 200: lưu {type:"api_key"} ─────────────────────────►│
     │◄─ "Đã kết nối" ─│                         │                        │
```

- Hoặc đặt biến môi trường ở cột "Biến môi trường". Không cần `/login`.
- **PHẢI** kiểm tra key bằng endpoint **có bảo vệ**. Endpoint `/models` công khai trả 200 với mọi key, nên không dùng để kiểm tra. Ví dụ OpenRouter dùng `https://openrouter.ai/api/v1/auth/key`.
- Nếu provider không có endpoint có bảo vệ rẻ, gửi một request chat `max_tokens: 1`. Ghi rõ trong file auth.

### 4.2. Subscription dùng API key của gói

Gói trả tháng (coding plan, token plan) cấp một API key riêng. Cách kết nối giống mục 4.1, chỉ khác biến môi trường và base URL. Ví dụ: `zai` (GLM Coding Plan), `zhipu-coding-plan`, `kimi-code` (`KIMI_API_KEY`), `minimax-code`, `alibaba-coding-plan`, `xiaomi-token-plan-*`, `firepass`, `cline-pass`, `opencode-go`, `opencode-zen`, `ollama-cloud`, `umans`, `synthetic`, `qwen-portal`.

- Mỗi gói là **một provider ID riêng**, không dùng chung với bản trả theo lượng dùng (ví dụ `minimax` và `minimax-code`). Lý do: khác key, khác base URL, khác giới hạn.
- Gói có hạn mức (5 giờ, tuần). Lỗi 429 thì báo người dùng "hết hạn mức của gói", không thử lại liên tục.

### 4.3. OAuth dành cho ứng dụng bên thứ ba

Chỉ dùng khi provider **công khai cho phép** ứng dụng khác dùng OAuth của họ. Trong danh sách: `openrouter` (PKCE, nhận về API key), `snowflake` (OAuth local application của Snowflake), `gitlab-duo` (OAuth app do người dùng tự đăng ký, hoặc Personal Access Token).

Luồng authorization code + PKCE:

```
 Axiom /login        Trình duyệt          Provider auth            Provider token
     │ tạo verifier,     │                      │                         │
     │ challenge, state  │                      │                         │
     │ mở URL ──────────►│ GET authorize ──────►│                         │
     │                   │◄── trang đăng nhập ──│                         │
     │                   │ người dùng đồng ý ──►│                         │
     │◄── redirect http://127.0.0.1:<port>/callback?code=… ─────────────│
     │ POST token {code, code_verifier} ───────────────────────────────►│
     │◄─────────────────────────────── {access, refresh?, expires?} ────│
     │ lưu auth.json {type:"oauth", ...}                                │
```

- Callback chỉ nghe trên `127.0.0.1`. Không mở cổng ra mạng.
- Không nhận được callback (máy từ xa) thì cho người dùng dán URL redirect hoặc mã code.
- Có `state` thì kiểm tra khớp. Sai `state` thì từ chối.

Luồng device code (cho máy không có trình duyệt):

```
 Axiom                     Provider
   │ POST device ──────────►│
   │◄── user_code, verification_uri, interval
   │ hiện: "Mở <uri>, nhập <user_code>"
   │ POST token (lặp mỗi interval giây) ─►│
   │◄── authorization_pending … rồi {access, refresh}
```

- Tôn trọng `interval`. Nhận `slow_down` thì tăng thời gian chờ thêm 5 giây.
- Hết `expires_in` thì dừng và báo người dùng.

Làm mới token: trước khi gọi model, nếu `expires` còn dưới 5 phút thì gọi refresh. Refresh lỗi 400/401 thì xoá credential và báo "Gõ `/login <provider>` lại".

### 4.4. Subscription OAuth (đăng nhập bằng tài khoản gói trả tháng)

Người dùng đăng nhập bằng tài khoản của gói (Claude Pro/Max, ChatGPT Plus/Pro, Copilot, …). Axiom nhận token OAuth và gọi model của provider bằng token đó. Dùng chung engine `oauth-code` và `device-code` ở mục 4.3. Chỗ nào engine chung không đủ thì dùng hook (mục 7.4).

| Provider | Gói | Luồng | Đăng nhập → lấy token | Callback | Sau khi lấy token | Refresh |
|---|---|---|---|---|---|---|
| `anthropic` | Claude Pro/Max | `oauth-code` + PKCE | `https://claude.ai/oauth/authorize` → `https://api.anthropic.com/v1/oauth/token` | `127.0.0.1:54545/callback` | Lấy account và organization | Có |
| `openai-codex` | ChatGPT Plus/Pro | `oauth-code` + PKCE | `https://auth.openai.com/oauth/authorize` → `https://auth.openai.com/oauth/token` | `127.0.0.1:1455/auth/callback`, cổng cố định (cổng bận thì báo lỗi, không đổi cổng) | Lấy profile, account ID | Có |
| `openai-codex-device` | ChatGPT Plus/Pro, máy không có trình duyệt | hook (device) | `https://auth.openai.com/api/accounts/deviceauth/usercode` → `…/deviceauth/token`; người dùng mở `https://auth.openai.com/codex/device` | — | Lưu dưới ID `openai-codex` | Có |
| `github-copilot` | Copilot | hook (device) | Hỏi domain (GitHub.com hoặc Enterprise) → `https://<domain>/login/device/code` → `https://<domain>/login/oauth/access_token` | — | — | Có |
| `cursor` | Cursor | hook (poll) | Mở `https://cursor.com/loginDeepControl`, hỏi lặp `https://api2.cursor.sh/auth/poll` | — | — | `https://api2.cursor.sh/oauth/token` |
| `devin` | Devin | `oauth-code` + PKCE | `https://app.devin.ai/auth/cli/continue` → `https://api.devin.ai/auth/cli/token` | `127.0.0.1:59653/callback` | — | Không |
| `google-gemini-cli` | Gemini Code Assist | `oauth-code` | `https://accounts.google.com/o/oauth2/v2/auth` → `https://oauth2.googleapis.com/token` | `127.0.0.1:8085/oauth2callback` | Tìm project Cloud Code Assist | Có |
| `google-antigravity` | Antigravity | `oauth-code` + PKCE | Như trên, client và scope riêng | `127.0.0.1:51121/oauth-callback` | Tìm project | Có |
| `xai-oauth` | SuperGrok, X Premium+ | `device-code` | `https://auth.x.ai/oauth2/device/code` → token endpoint lấy từ discovery của `auth.x.ai` | — | Lấy userinfo | Có |
| `gitlab-duo` | GitLab Duo | `oauth-code` + PKCE | `https://gitlab.com/oauth/authorize` → `https://gitlab.com/oauth/token` | `127.0.0.1:8080/callback`. Có thể thay bằng OAuth app riêng (`GITLAB_CLIENT_ID`, `GITLAB_REDIRECT_URI`) hoặc PAT (`GITLAB_TOKEN`) | Xoá cache model | Có |
| `gitlab-duo-agent` | GitLab Duo Agent | `oauth-code` + PKCE | Như `gitlab-duo` | Redirect `vscode://…`, người dùng dán URL vào Axiom | — | Có |
| `muse-code` | Muse Code (Meta) | `device-code` | `https://auth.meta.com/oidc/device/authorization/` → `…/oidc/device/token/` | — | Đổi token lấy API key, dùng API key để gọi model | Không |
| `factory-droid` | Factory | `device-code` | `https://api.workos.com/user_management/authorize/device` → `…/user_management/authenticate` | — | Lấy region và org ID (header `X-Factory-Org-Id`) | Có |
| `zai-coding-plan` | GLM Coding Plan (đăng nhập) | `oauth-code`, không PKCE | `https://chat.z.ai/api/oauth/authorize` → `https://zcode.z.ai/api/v1/oauth/token` | Redirect `zcode://zai-auth/callback`, người dùng dán URL | Tạo API key bền, lưu dưới dạng API key | Không |
| `kimi-code` | Kimi Code | `device-code` | `https://auth.kimi.com/api/oauth/device_authorization` → `https://auth.kimi.com/api/oauth/token` | — | — | Có |

Quy tắc:
- `clientId`, scope và header bắt buộc của từng provider ghi trong file auth JSON của provider đó, kèm trường `"source"` ghi lấy từ đâu (URL tài liệu hoặc file nguồn công khai). Không ghi trong code TypeScript.
- Token chỉ dùng để gọi model của chính provider đó. Không gửi token sang provider khác.
- Provider có thể đổi luồng đăng nhập, chặn client, hoặc khoá tài khoản bất cứ lúc nào. Vì vậy **eval và video demo dùng API key** (mục 4.1, 4.2). Subscription OAuth chỉ là tiện ích cho người dùng.
- Đăng nhập lỗi do provider đổi luồng thì báo rõ "Luồng đăng nhập của `<provider>` đã thay đổi, dùng API key hoặc cập nhật file auth". Không crash.

### 4.5. Cloud credentials

`amazon-bedrock`, `bedrock-mantle` (AWS SigV4), `google-vertex` (ADC), `azure` (key + resource), `cloudflare-ai-gateway` (token + account + gateway), `snowflake` (PAT + account). `/login` cho các provider này hỏi **nhiều trường** và lưu chung một bản ghi.

### 4.6. Local (không cần key)

`ollama` (`http://127.0.0.1:11434/v1`), `lm-studio` (`http://127.0.0.1:1234/v1`), `llama.cpp` (`http://127.0.0.1:8080/v1`), `vllm` (`http://127.0.0.1:8000/v1`), `litellm` (`http://localhost:4000/v1`).

- Available khi không có key. Model lấy bằng discovery `GET <baseUrl>/models`.
- Server không chạy thì `/model` hiện "ollama: không kết nối được 127.0.0.1:11434", không crash.

### 4.7. Không làm

| Provider | Lý do |
|---|---|
| `stencil` | Chỉ mời riêng (invite only). Chỉ có trong `/login`, không có trong catalog nên không nằm trong bảng mục 3 |
| `typesafe`, `cloudflare-workers-ai` | Model phán đoán (judge), không phải model chat |
| `local`, `apple` | Cần runtime native trong process, hoặc chỉ chạy trên macOS |

## 5. Thứ tự lấy credential (cái nào có trước thì dùng)

Giống oh-my-pi, bỏ các nguồn không áp dụng:

1. `--api-key` trên dòng lệnh. Chỉ dùng cho lần chạy đó, không lưu.
2. `apiKey` của provider trong `~/.axiom/models.json`. Nguồn này thắng OAuth đã lưu, để key của một gateway riêng không bị thay bằng token OAuth.
3. OAuth đã lưu (mục 4.3, 4.4), tự làm mới khi sắp hết hạn.
4. API key đã lưu bằng `/login`.
5. Biến môi trường của provider, theo thứ tự trong cột "Biến môi trường".
6. `~/.axiom/.env`.

Khác oh-my-pi:
- **Không đọc `.env` của project**, `~/.env`, hay file cấu hình trong project. Target repo là dữ liệu không tin cậy, và policy đã cấm agent đọc `.env`.
- Mỗi provider chỉ có **một** tài khoản. Không xoay vòng nhiều tài khoản, không auth broker.

`apiKey` trong `models.json` nhận 3 dạng (giống oh-my-pi):
- Tên biến môi trường viết đúng hoa thường, có giá trị → dùng giá trị biến đó.
- `!lệnh` → chạy lệnh, lấy stdout đã cắt khoảng trắng (ví dụ `!pass show openrouter`). Chỉ chấp nhận trong `~/.axiom/models.json`. Timeout 5 giây.
- Còn lại → dùng chính chuỗi đó làm key.

## 6. Wire

| Wire | Có trong Axiom | Provider dùng | Phase |
|---|---|---|---|
| `openai-completions` | Có (`src/llm/providers/openai.ts`) | phần lớn provider | 1 |
| `anthropic-messages` | Có (`src/llm/providers/anthropic.ts`) | `anthropic`, `zai`, `minimax*`, `umans`, `vercel-ai-gateway`, … | 1 |
| `openrouter` | Dùng `openai-completions`, thêm header `HTTP-Referer`, `X-Title` | `openrouter` | 1 |
| `openai-responses` | Chưa | `openai`, `xai`, `meta`, `sakana`, `abliteration`, `bedrock-mantle` | 1 |
| `google-generative-ai` | Chưa | `google` | 1 |
| `ollama-chat` | Chưa | `ollama-cloud` | 1 |
| `openai-codex-responses` | Chưa | `openai-codex`, `openai-codex-device` | 1 |
| `google-gemini-cli` | Chưa | `google-gemini-cli`, `google-antigravity` | 1 |
| `azure-openai-responses`, `google-vertex`, `bedrock-converse-stream` | Chưa | `azure`, `google-vertex`, `amazon-bedrock` | 1 |
| `cursor-agent`, `devin-agent`, `factory-droid-agent`, `gitlab-duo-agent` | Chưa | `cursor`, `devin`, `factory-droid`, `gitlab-duo-agent` | 1 |

- Code chọn wire theo `ModelInfo.api`, **không** theo tên provider.
- Thêm provider mới dùng wire đã có thì **chỉ thêm file JSON**, không sửa code TypeScript.
- Mỗi wire mới là một class trong `src/llm/providers/`, kế thừa `BaseLLMProvider`, đăng ký trong bảng `WIRES` của `src/llm/provider-factory.ts`.

## 7. Cách thêm provider

Giống oh-my-pi, một provider có sẵn gồm **hai nửa**: nửa catalog và nửa auth. Có 4 cách thêm:

```
 Cách 1: provider có sẵn ─► catalog/providers/<id>.json + catalog/auth/<id>.json + auth/_order.json
 Cách 2: người dùng tự thêm ─► ~/.axiom/models.json (provider đầy đủ, hoặc chỉ ghi đè)
 Cách 3: server local ─► discovery GET <baseUrl>/models
 Cách 4: luồng đăng nhập đặc biệt ─► src/llm/auth/hooks/<id>.ts
```

### 7.1. Cách 1 — Provider có sẵn (nhóm thêm vào repo)

**Nửa catalog** — `src/llm/catalog/providers/<id>.json`:

```json
{
  "id": "deepseek",
  "defaultModel": "deepseek-v4-pro",
  "env": ["DEEPSEEK_API_KEY"],
  "api": "openai-completions",
  "baseUrl": "https://api.deepseek.com",
  "discovery": { "allowUnauthenticated": false },
  "seed": [
    { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "reasoning": true, "input": ["text"],
      "contextWindow": 131072, "maxTokens": 8192,
      "cost": { "input": 0.5, "output": 2, "cacheRead": 0.05, "cacheWrite": 0 } }
  ]
}
```

| Trường | Bắt buộc | Nghĩa |
|---|---|---|
| `id` | Có | Trùng tên file. Chữ thường, `-` và `.` |
| `defaultModel` | Có | Model chọn khi người dùng chỉ chọn provider |
| `env` | Không | Biến môi trường chứa key, theo thứ tự ưu tiên. Bỏ trống = provider không dùng key qua biến môi trường |
| `api`, `baseUrl` | Có | Wire và URL mặc định của mọi model. Một model có thể ghi đè |
| `discovery` | Không | Có thì provider hỗ trợ `GET <baseUrl>/models`. `allowUnauthenticated: true` cho phép lấy danh sách khi chưa có key |
| `seed` | Có, ít nhất `defaultModel` | Model có sẵn khi offline. Mỗi model cần `name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens` |
| `headers` | Không | Header cố định thêm vào mọi request |
| `available` | Không | `false` = provider trong mục 4.7 |

**Nửa auth** — `src/llm/catalog/auth/<id>.json`:

```json
{ "id": "deepseek", "name": "DeepSeek",
  "login": { "type": "api-key", "authUrl": "https://platform.deepseek.com/api_keys",
             "prompt": "Dán DeepSeek API key", "placeholder": "sk-...",
             "validate": { "kind": "chat-completions", "model": "deepseek-v4-pro" } },
  "refresh": "none" }
```

| `login.type` | Dùng khi | Trường |
|---|---|---|
| (không có `login`) | Chỉ dùng biến môi trường | — |
| `api-key` | Dán key | `authUrl`, `prompt`, `placeholder`, `validate` (`{kind:"url", url}` hoặc `{kind:"chat-completions", model}`) |
| `oauth-code` | Mục 4.3, 4.4, có trình duyệt | `authorizeUrl`, `tokenUrl`, `clientId`, `scopes`, `pkce`, `state`, `callback {port, path, redirectUri?, manualOnly?}`, `headers`, `credential` (đường dẫn tới `access`, `refresh`, `expires`, `email`, `accountId`), `afterExchange` (tên hook), `source` |
| `device-code` | Mục 4.3, 4.4, không có trình duyệt | `deviceUrl`, `tokenUrl`, `clientId`, `scopes`, `credential`, `afterExchange`, `source` |
| `custom` | Không viết được bằng các trường trên (nhiều trường như Cloudflare) | `hook`: tên file trong `src/llm/auth/hooks/` |

`refresh` là bắt buộc với `oauth-code` và `device-code`: `"none"`, `{ "tokenUrl": "…" }`, hoặc `{ "hook": "…" }`.

**Thứ tự trong `/login`** — `src/llm/catalog/auth/_order.json`: mảng ID. Provider có `login` **PHẢI** có trong mảng này. Test kiểm tra điều này.

**PHẢI**:
- Lấy URL, tên biến, model mặc định từ tài liệu chính thức của provider. Bảng ở mục 3 chỉ là điểm bắt đầu.
- Kiểm tra thật trước khi merge: đăng nhập, `/model` thấy model, chat 1 câu có gọi tool.

**KHÔNG ĐƯỢC**:
- Thêm nhánh `if (provider === 'x')` trong wire. Khác biệt của provider ghi trong JSON (`headers`, `baseUrl`, trường của model).

### 7.2. Cách 2 — Người dùng tự thêm trong `~/.axiom/models.json`

Provider đầy đủ (có `models`):

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "MY_GATEWAY_API_KEY",
      "authHeader": true,
      "models": [
        { "id": "qwen3-coder", "name": "Qwen3 Coder", "contextWindow": 262144, "maxTokens": 8192,
          "cost": { "input": 0.3, "output": 1.2 } }
      ]
    }
  }
}
```

Chỉ ghi đè provider có sẵn (không có `models`), ví dụ đổi URL cho OpenRouter qua proxy công ty:

```json
{ "providers": { "openrouter": { "baseUrl": "https://proxy.company.vn/openrouter/v1" } } }
```

| Trường | Nghĩa |
|---|---|
| `baseUrl`, `api` | Bắt buộc với provider đầy đủ. `api` phải là wire có trong mục 6 |
| `apiKey` | Mục 5: tên biến, `!lệnh`, hoặc chuỗi |
| `auth` | `"none"` cho endpoint không cần key |
| `authHeader` | `true`: gửi key trong header `Authorization: Bearer <key>` |
| `headers` | Header thêm vào mọi request |
| `discovery` | `{ "type": "openai-models" }` để lấy model bằng `GET /models` |
| `models[]` | `id` bắt buộc. `contextWindow` thiếu thì dùng 128000 và hiện cảnh báo một lần |

Quy tắc kiểm tra (giống oh-my-pi):
- Provider đầy đủ thiếu `baseUrl` hoặc `api` → bỏ provider đó, in cảnh báo có tên file và tên trường.
- Provider ghi đè chỉ được có `baseUrl`, `apiKey`, `headers`, `authHeader`. Trường khác → cảnh báo.
- `models.json` sai cú pháp JSON → bỏ cả file, in cảnh báo, Axiom vẫn chạy với provider có sẵn.

### 7.3. Cách 3 — Server local và discovery

- `GET <baseUrl>/models` có timeout 5 giây. Kết quả lưu ở `~/.axiom/models-cache.json` kèm thời điểm. Hết hạn sau 24 giờ.
- Lúc khởi động chỉ đọc cache, **không** chờ mạng. Discovery chạy khi mở `/model` hoặc khi gõ `axiom models refresh`.
- Discovery thành công thì gộp vào `seed`: model trong `seed` giữ thông tin của `seed`, model mới lấy thông tin từ discovery. Model trong `models.json` của người dùng luôn thắng.

### 7.4. Cách 4 — Hook đăng nhập đặc biệt

`src/llm/auth/hooks/<id>.ts` export `login(ctx: LoginContext): Promise<StoredCredential>` và (nếu cần) `refresh(cred): Promise<StoredCredential>`. Chỉ dùng khi các kiểu ở mục 7.1 không đủ. Ví dụ `cloudflare-ai-gateway` hỏi 3 trường. Hook nạp lười (dynamic `import()`), không nạp khi khởi động.

## 8. File cấu hình và lưu trữ

| File | Nội dung | Quyền |
|---|---|---|
| `~/.axiom/config.json` | `modelRoles`, `defaultModel`, `disabledProviders`, `enabledProviders`, `budgetLimitDollars` | 0644 |
| `~/.axiom/models.json` | Provider tự thêm và ghi đè (mục 7.2) | 0600 (có thể chứa key) |
| `~/.axiom/auth.json` | Credential từ `/login`: `{ "<id>": { "type": "api_key", "key": "…" } }` hoặc `{ "type": "oauth", "access": "…", "refresh": "…", "expires": 1730000000000, "email": "…" }` | **0600**, ghi file tạm rồi `rename` |
| `~/.axiom/models-cache.json` | Kết quả discovery | 0644 |
| `~/.axiom/.env` | Key dạng biến môi trường | 0600 |

`AXIOM_HOME` đổi thư mục `~/.axiom` (dùng cho test).

`disabledProviders` được kiểm tra **trước** credential: provider bị tắt thì không available dù có key. `enabledProviders` có giá trị thì chỉ các provider trong danh sách đó được dùng.

## 9. Role và cách chọn model

| Role | Dùng cho | Nếu chưa đặt thì dùng |
|---|---|---|
| `default` | Chat tự do, Coder | `defaultModel` |
| `smol` | Model rẻ: triage, đặt tên phiên, tóm tắt | `default` |
| `slow` | Model mạnh: Oracle | `default` |
| `plan` | Planner trong plan mode và spec | `slow` |
| `review` | Reviewer (UC-06) | `default` |
| `task` | Subagent | `default` |
| `code` | Sửa code | `default` |
| `embed` | Embedding | Bắt buộc cấu hình `modelRoles.embed`; thiếu thì báo lỗi |

```json
{ "modelRoles": { "default": "zai/glm-5.3", "smol": "@default", "slow": "anthropic/claude-sonnet-5-5" } }
```

Ví dụ: `{ "modelRoles": { "code": "anthropic/<model-code>", "embed": "ollama/<model-embed>" } }`.

- `@ten` là alias tới role khác. Có thể thêm hậu tố mức suy nghĩ: `zai/glm-5.3:high` (`off|minimal|low|medium|high|xhigh`).
- Một role có thể có nhiều selector cách nhau bằng dấu phẩy. Dùng selector **đầu tiên available**. Đây không phải chuỗi thử lại khi lỗi.
- Code của UC luôn xin model theo role (`resolveModel('@smol')`), **không viết cứng tên model**.

Chọn model khi khởi động (giống oh-my-pi):
1. `--model` trên dòng lệnh.
2. `modelRoles.default`.
3. Model dùng gần nhất (lưu ở `config.json`).
4. `defaultModel` của provider available đầu tiên theo thứ tự `/login`.

Không có provider nào available thì TUI hiện màn hình chào: "Chưa có provider. Gõ `/login` hoặc đặt biến môi trường của provider." Không crash.

Thứ tự phân giải selector: `provider/id` khớp chính xác → `id` khớp chính xác (không phân biệt hoa thường; trùng nhiều provider thì lấy provider dùng gần nhất, rồi theo thứ tự `/login`) → báo lỗi kèm tối đa 5 gợi ý gần giống.

## 10. Lệnh

| Lệnh | Việc |
|---|---|
| `/login` | Danh sách provider theo `_order.json`, có ô lọc. Hiện cách kết nối và trạng thái (đã kết nối / chưa) |
| `/login <provider>` · `axiom login [<provider>]` | Chạy luồng đăng nhập của provider đó (mục 4) |
| `/login <redirect-url>` | Hoàn tất OAuth bằng cách dán URL redirect |
| `/logout [<provider>]` | Xoá credential đã lưu |
| `/model` | Bộ chọn model: nhóm theo provider, hiện context, giá. Chỉ đổi model của phiên hiện tại |
| `/model role <role> <selector>` | Đặt model cho role, ghi vào `config.json` |
| `axiom models` · `axiom models <provider>` | In bảng model available, nhóm theo provider |
| `axiom models find <chuỗi>` | Lọc theo provider, id, tên |
| `axiom models refresh` | Chạy discovery, bỏ qua cache |
| `--json` | In JSON (`provider`, `id`, `selector`, `name`, `contextWindow`, `maxTokens`, `cost`) |

Không có credential khi gọi model thì báo: "`<provider>` chưa kết nối. Gõ `/login <provider>` hoặc đặt `<ENV_NAME>`."

## 11. Bảo vệ secret (bắt buộc, liên quan K8 và case tấn công §4.3 số 1)

```
 process.env (có *_API_KEY)
        │
        ▼
 [scrubEnv] ── bỏ biến tên chứa KEY|SECRET|TOKEN|PASSWORD|AUTH|CREDENTIAL|PRIVATE ──► env sạch
        │                                                                                │
        ▼                                                                                ▼
 wire (cần credential)                                                   run_command, run_tests (con)
                                                                                         │
 tool output ──► [redact: thay giá trị secret đã biết bằng ‹redacted›] ──► LLM, trace ◄──┘
```

- **Lỗ hổng hiện tại (phải sửa trước hết):** `src/tools/bash.ts` gọi `spawn` mà không truyền `env`, nên process con nhận toàn bộ `process.env`. Ngoài ra `env` và `printenv` đang nằm trong danh sách lệnh chỉ đọc. Agent gõ `printenv` là API key đi vào context của LLM và vào trace.
- Giá trị secret để redact gồm: biến môi trường có tên khớp mẫu trên (dài từ 8 ký tự), mọi key và token trong `auth.json`, `apiKey` đã phân giải từ `models.json`.
- Key và token không bao giờ được in ra log, trace, hay thông báo lỗi. Khi báo lỗi chỉ ghi tên biến (`OPENROUTER_API_KEY`).
- Repo chỉ commit `.env.example`. Bước 1/6 của `scripts/ci-local.sh` quét tên file bí mật và mẫu key trên diff so với `origin/main` (GitHub Actions của repo đã tắt, local CI là cổng bắt buộc).

## 12. Các bước làm (theo đúng thứ tự)

Lệnh kiểm tra sau **mỗi** bước: `npm run lint && npm test`. Cả hai phải pass rồi mới commit.

### Bước 1 — Chặn lộ key qua process con (Phase 1)

| | |
|---|---|
| File | Mới: `src/core/secrets.ts`. Sửa: `src/tools/bash.ts`, `src/tools/permissions.ts`, `src/tools/registry.ts` |
| Interface | `export const SECRET_NAME = /KEY\|SECRET\|TOKEN\|PASSWORD\|PASS\|AUTH\|CREDENTIAL\|PRIVATE/i`<br>`export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`<br>`export function registerSecret(value: string): void` (credential store gọi khi đọc key)<br>`export function redact(text: string): string` (thay bằng `‹redacted›`) |
| PHẢI | `spawn(...)` trong `bash.ts` nhận `env: scrubEnv(process.env)`. Xoá `env` và `printenv` khỏi `READ_ONLY_COMMANDS`. `ToolRegistry.executeTool` gọi `redact(output)` trước khi trả kết quả. |
| KHÔNG ĐƯỢC | Xoá `PATH`, `HOME`, `LANG`, `TERM` khỏi env của process con. |
| Test | `printenv` và `echo $OPENROUTER_API_KEY` không lộ giá trị key. `redact` thay mọi chỗ key xuất hiện. |

Call-stack diff:

```
TRƯỚC                                      SAU
ToolRegistry.executeTool                   ToolRegistry.executeTool
 └─ BashTool.execute                        ├─ BashTool.execute
     └─ spawn(cmd, {cwd})                   │   └─ spawn(cmd, {cwd, env: scrubEnv(process.env)})  [đổi]
                                            └─ redact(output)                                   [mới]
```

### Bước 2 — Catalog (Phase 1)

| | |
|---|---|
| File | Mới: `src/llm/catalog/index.ts`, `src/llm/catalog/providers/*.json`, `src/llm/catalog/auth/*.json`, `src/llm/catalog/auth/_order.json`. Sửa: `src/core/types.ts` (thêm `'plan' \| 'review'` vào `ModelRole`, thêm `disabledProviders`, `enabledProviders`), `src/core/config.ts` (`AXIOM_HOME`) |
| Interface | `export interface ModelInfo { provider: string; id: string; name: string; api: WireApi; baseUrl: string; contextWindow: number; maxTokens?: number; reasoning: boolean; input: ('text'\|'image')[]; cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; headers?: Record<string,string> }`<br>`export function loadCatalog(home?: string): Catalog`<br>`Catalog.providers(): ProviderEntry[]`, `Catalog.models(provider?: string): ModelInfo[]`, `Catalog.isAvailable(id: string, env?: NodeJS.ProcessEnv): boolean` |
| PHẢI | Có đủ **91** file provider và file auth theo bảng mục 3. Provider "Không làm" có `"available": false` và `"reason"`. Gộp `models.json` theo mục 7.2. |
| KHÔNG ĐƯỢC | Gọi mạng trong `loadCatalog` hoặc `isAvailable`. |
| Test | Mỗi file JSON đúng schema (một test duyệt cả thư mục). Mọi provider có `login` đều có trong `_order.json`. `disabledProviders` thắng credential. `ollama` available khi không có key. `models.json` hỏng không làm crash. |

Mẹo: viết một script một lần (không commit) để sinh 91 cặp file từ bảng mục 3, rồi sửa tay từng file theo tài liệu chính thức của provider.

### Bước 3 — Lưu credential và thứ tự lấy credential (Phase 1)

| | |
|---|---|
| File | Mới: `src/llm/auth/store.ts`, `src/llm/auth/resolve.ts` |
| Interface | `export type StoredCredential = { type: 'api_key'; key: string } \| { type: 'oauth'; access: string; refresh?: string; expires?: number; email?: string } \| { type: 'fields'; values: Record<string, string> }`<br>`export type CredentialSource = 'cli' \| 'models.json' \| 'oauth' \| 'login' \| 'env' \| 'axiom-env'`<br>`export async function resolveCredential(provider: string, opts: { cliKey?: string; env?: NodeJS.ProcessEnv; home?: string }): Promise<{ value: string; source: CredentialSource } \| null>` |
| PHẢI | Đúng thứ tự mục 5. OAuth sắp hết hạn thì refresh trước khi trả. Mọi giá trị trả về đều gọi `registerSecret`. Ghi `auth.json` atomic, quyền `0o600`. Thư mục `~/.axiom` quyền `0o700`. |
| KHÔNG ĐƯỢC | Ghi giá trị credential vào log, lỗi, trace. |
| Test | Tạo cả 6 nguồn, xoá lần lượt từng nguồn, kiểm tra `source`. `auth.json` quyền `0600`. `!echo abc` trong `models.json` cho `abc`. |

### Bước 4 — Model resolver và wire (Phase 1)

| | |
|---|---|
| File | Mới: `src/llm/model-resolver.ts`. Sửa: `src/llm/provider-factory.ts` (bảng `WIRES: Record<WireApi, (info, credential) => BaseLLMProvider>`) |
| Interface | `export function resolveModel(selector: string, catalog: Catalog, config: AxiomConfig): ModelInfo & { thinking?: ThinkingLevel }`<br>`export async function createProviderFor(info: ModelInfo, opts?: { cliKey?: string }): Promise<BaseLLMProvider>` |
| PHẢI | Thứ tự phân giải ở mục 9. Alias vòng (`a → b → a`) báo lỗi. Wire chưa có thì báo "`<provider>` cần wire `<api>`, chưa hỗ trợ". |
| KHÔNG ĐƯỢC | Tìm gần đúng để **chọn** model (chỉ dùng để gợi ý trong thông báo lỗi). |
| Test | `@smol` chưa đặt rơi về `default`. Danh sách nhiều selector lấy cái available đầu tiên. Selector sai báo lỗi có gợi ý. |

Cách dùng trong code của UC (đây là cách duy nhất được phép):

```ts
const info = resolveModel('@smol', catalog, config);
const agent = new AgentLoop({
  config,
  provider: await createProviderFor(info),
  model: info.id,
  systemPrompt: TRIAGE_PROMPT,
  toolRegistry: new ToolRegistry(['read_file', 'search_code']),
});
```

### Bước 5 — Đăng nhập API key và lệnh (Phase 1)

| | |
|---|---|
| File | Mới: `src/llm/auth/engines/api-key.ts`, `src/commands/login.ts`, `logout.ts`, `model.ts`, `models.ts` |
| PHẢI | Dùng interface `Command` trong `docs/guides/tui.md` mục 9. `/login` theo mục 4.1 và mục 10. Kiểm tra key có timeout 10 giây. |
| Test | `axiom models --json` với `AXIOM_HOME` tạm in JSON hợp lệ. Luồng `api-key` với server HTTP giả: 200 thì lưu, 401 thì không lưu. |

### Bước 6 — Discovery (Phase 1)

`src/llm/discovery.ts` theo mục 7.3. Test với server HTTP giả: timeout, JSON hỏng, cache hết hạn.

### Bước 7 — OAuth code và device code (Phase 1)

`src/llm/auth/engines/oauth-code.ts`, `device-code.ts`, `refresh.ts` theo mục 4.3, rồi các provider subscription ở mục 4.4 và hook `github-copilot`, `cursor`, `openai-codex-device`. Thứ tự làm: `openrouter` → `anthropic` → `openai-codex` → `github-copilot` → `google-gemini-cli` → phần còn lại. Test với server OAuth giả chạy trên `127.0.0.1`: sai `state` bị từ chối, `slow_down` tăng thời gian chờ, refresh lỗi thì xoá credential, cổng cố định bị bận thì báo lỗi.

### Bước 8 — Wire mới (Phase 1)

`openai-responses`, `google-generative-ai`, `ollama-chat`, `openai-codex-responses`, `google-gemini-cli` theo mục 6. Mỗi wire có test với server giả: stream text, gọi tool, báo usage.

### Bước 9 — Cloud và hook (Phase 1)

`azure-openai-responses`, `google-vertex`, `bedrock-converse-stream`, `cursor-agent`, `devin-agent`, `factory-droid-agent`, `gitlab-duo-agent`. Hook `/login` nhiều trường (mục 4.5, 7.4) và đăng nhập của `cursor`, `devin`, `factory-droid`, `gitlab-duo-agent`. Mỗi wire có test với server giả như bước 8.

## 12.1. Checklist trước khi mở PR

- [ ] `npm run lint && npm test` pass.
- [ ] `grep -rn "claude-\|gpt-\|glm-\|qwen" src/ --include=*.ts` không có tên model viết cứng (tên model chỉ nằm trong JSON).
- [ ] Mỗi `clientId` trong `src/llm/catalog/auth/` có trường `"source"`.
- [ ] Không có giá trị key nào trong `git diff`. `npm run ci:local` qua bước 1/6 (quét tên file bí mật và mẫu `sk-`, `sk-ant-`, `ghp_`, `xox`, `BEGIN PRIVATE KEY`).
- [ ] Provider mới: đã đăng nhập thật, `/model` thấy model, chat 1 câu có gọi tool.
- [ ] Đã cập nhật README nếu đổi lệnh hoặc file cấu hình.
- [ ] Đổi thiết kế thì đã ghi vào "Nhật ký quyết định" trong `docs/DESIGN.md`.

## 13. Không làm (ngoài phạm vi đồ án)

Các provider ở mục 4.7, xoay vòng nhiều tài khoản, auth broker và gateway, preset model, chọn model theo glob, context promotion, cấu hình provider ở mức project, che secret có thể đảo ngược (oh-my-pi thay bằng placeholder rồi khôi phục; Axiom chỉ thay một chiều). Muốn thêm thì ghi vào "Nhật ký quyết định" của `docs/DESIGN.md` trước.
