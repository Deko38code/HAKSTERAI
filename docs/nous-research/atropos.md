[Skip to content](https://nousresearch.com/introducing-atropos#content)

- [Home](https://nousresearch.com/)
- [Hermes Agent](https://hermes-agent.nousresearch.com/)
- [Nous Portal](https://portal.nousresearch.com/)
- [Psyche](https://psyche.network/)
- [Hermes 4](https://hermes4.nousresearch.com/)
- [Releases](https://nousresearch.com/releases/)
- [Careers](https://nousresearch.com/careers/)
- [Shop](https://shop.nousresearch.com/)
- [Blog](https://nousresearch.com/blog/)

Menu

- [Home](https://nousresearch.com/)
- [Hermes Agent](https://hermes-agent.nousresearch.com/)
- [Nous Portal](https://portal.nousresearch.com/)
- [Psyche](https://psyche.network/)
- [Hermes 4](https://hermes4.nousresearch.com/)
- [Chat](https://chat.nousresearch.com/)
- [Releases](https://nousresearch.com/releases/)
- [Careers](https://nousresearch.com/careers/)
- [Shop](https://shop.nousresearch.com/)
- [Blog](https://nousresearch.com/blog/)

# Introducing Atropos

# Introducing Atropos

![Atropos logo and title image](https://5jdxmo9ix2ncv3a2.public.blob.vercel-storage.com/atr-banner-01-T5dSSdAga2O9wNp7dVf2hZutZBeLd6.jpg)

Pushing the boundaries of **reinforcement learning**, particularly in complex environments or with large models, inevitably requires operating at a massive scale. Coordinating thousands of **parallel computations** efficiently becomes paramount. Landmark achievements, such as OpenAI's Five agent mastering Dota 2 \[2\], showcased the power and necessity of highly **distributed, asynchronous systems**. Their architecture coordinated vast numbers of parallel actors generating gameplay experience with learners updating the policy, demonstrating how **asynchronicity** can overcome bottlenecks inherent in large-scale training.

![Dota 2 with Large Scale Deep Reinforcement Learning](https://5jdxmo9ix2ncv3a2.public.blob.vercel-storage.com/PsycheStaticBlog/Atropos_Viz-72Q4GaXDpkUPSuzSn1GjFqXOZtKnIk.jpg)

Scalable asynchronous coordination system for distributed reinforcement learning

These lessons translate directly to the challenges of **Reinforcement Learning with Large Language Models** (RLHF/RLAIF/RLVR). Effectively utilizing potentially thousands of GPUs for generating text rollouts, especially when dealing with the highly variable completion times inherent in processing different prompts, demands sophisticated **asynchronous coordination**. Without it, valuable compute resources remain idle, significantly slowing down the learning process. This need for efficient, scalable rollout management in distributed settings is precisely what led us to develop our own internal asynchronous LLM RL pipelines, of which the first we are releasing today: **Atropos**.

As the dedicated **rollout handler** within our pipeline, Atropos is designed to reliably coordinate generation tasks across potentially thousands of **distributed workers**. It interfaces seamlessly with standard inference APIs for straightforward integration. Key features include its **distributed architecture**, ensuring scalability and robustness, and its asynchronous handling of results – efficiently managing completions from prompts of varying lengths to maximize throughput at the rollout management stage.

We developed Atropos because managing rollouts efficiently is the crucial first step towards truly **scalable asynchronous LLM RL**. It serves as the foundation for our complete system. Looking ahead, we plan to release the corresponding training and inference pipelines from Nous. These components feature advanced optimizations, such as **non-blocking, in-place weight updates**, designed to eliminate synchronization delays entirely, allowing for continuous generation and maximizing large-scale training efficiency.

\[1\] Atropos repository – [https://github.com/NousResearch/Atropos](https://github.com/NousResearch/Atropos)

\[2\] OpenAI Five – [\[1912.06680\] Dota 2 with Large Scale Deep Reinforcement Learning](https://arxiv.org/abs/1912.06680)

[NOUS RESEARCH](https://nousresearch.com/)

ARTIFICIAL INTELLIGENCE MADE HUMAN

- [Home](https://nousresearch.com/)
- [Hermes Agent](https://hermes-agent.nousresearch.com/)
- [Nous Portal](https://portal.nousresearch.com/)
- [Psyche](https://nousresearch.com/nous-psyche/)
- [Hermes 4](https://hermes4.nousresearch.com/)
- [Simulators](https://sims.nousresearch.com/)
- [Releases](https://nousresearch.com/releases/)
- [Careers](https://nousresearch.com/careers/)
- [Blog](https://nousresearch.com/blog/)
- [Shop](https://shop.nousresearch.com/)

- [Home](https://nousresearch.com/)
- [Hermes Agent](https://hermes-agent.nousresearch.com/)
- [Nous Portal](https://portal.nousresearch.com/)
- [Psyche](https://nousresearch.com/nous-psyche/)
- [Hermes 4](https://hermes4.nousresearch.com/)
- [Nous Chat](https://chat.nousresearch.com/)
- [Simulators](https://sims.nousresearch.com/)
- [Releases](https://nousresearch.com/releases/)
- [Careers](https://nousresearch.com/careers/)
- [Blog](https://nousresearch.com/blog/)
- [Shop](https://shop.nousresearch.com/)

```
NODES
```

[→ HuggingFace](https://huggingface.co/NousResearch)

[→ Discord](https://discord.gg/jqVphNsB4H)

[→ LinkedIn](https://www.linkedin.com/company/nousresearch/)

[→ Twitter](https://twitter.com/nousresearch)

[→ Email](https://nousresearch.com/cdn-cgi/l/email-protection#f59e9487949bb59b9a8086879086909487969ddb969a98)

[→ GitHub](https://github.com/NousResearch)

[→ Careers](https://nousresearch.com/careers/)

[NOUS RESEARCH](https://nousresearch.com/)

THE AI ACCELERATOR COMPANY

NODES

[→ SIMULATORS](https://sims.nousresearch.com/)

[→ NOUS BLOG](https://nousresearch.com/blog)

[→ HuggingFace](https://huggingface.co/NousResearch)

[→ Discord](https://discord.gg/jqVphNsB4H)

[→ LinkedIn](https://www.linkedin.com/company/nousresearch/)

[→ Twitter](https://twitter.com/nousresearch)

[→ Email](https://nousresearch.com/cdn-cgi/l/email-protection#7813190a19163816170d0b0a1d0b1d190a1b10561b1715)

[→ GitHub](https://github.com/NousResearch)