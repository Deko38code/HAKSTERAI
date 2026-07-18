[Skip to content](https://nousresearch.com/introducing-hermes-4-3#content)

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
- [API\\
Portal](https://portal.nousresearch.com/)
- [Psyche](https://psyche.network/)
- [Hermes\\
4](https://hermes4.nousresearch.com/)
- [Chat](https://chat.nousresearch.com/)
- [Releases](https://nousresearch.com/releases/)
- [Careers](https://nousresearch.com/careers/)
- [Shop](https://shop.nousresearch.com/)
- [Blog](https://nousresearch.com/blog/)

# Introducing Hermes 4.3: Local Intelligence Globally Trained

![](https://nousresearch.com/wp-content/uploads/2025/12/435_b_s_2-1536x960.jpg)

Today we’re releasing Hermes 4.3 ( [🤗 Hugging Face](https://huggingface.co/NousResearch/Hermes-4.3-36B)),
an update to our flagship Hermes series of models. Hermes 4.3 was trained with an
extended context length (up to 512K) and nearly matches (and in some cases exceeds)
the performance of Hermes 4 70B at half the parameter cost. Based on [Seed-OSS-36B-Base](https://huggingface.co/ByteDance-Seed/Seed-OSS-36B-Base),
Hermes 4.3 is an excellent shape for consumer local inference or enterprise
self-deployment. The [GGUFs](https://huggingface.co/NousResearch/Hermes-4.3-36B-GGUF)
comfortably sit in the VRAM of off-the-shelf GPUs, offering a private, powerful,
neutrally-aligned model to everyone.

Hermes 4.3 is our first production model post-trained entirely on the [Psyche](https://psyche.network/) network, our distributed training
network that uses the DisTrO optimizer to efficiently communicate between training
nodes spread out through data centers over the open internet and secured by the
consensus of the Solana blockchain. By enabling nodes throughout the world to
collaborate on a single training run, Psyche can dramatically reduce the cost of
training frontier level models, leveling the playing field for open source AI model
developers.

Although we’ve performed extensive scientific research on DisTrO and its
implementation in Psyche, we decided to verify its effectiveness for production
workloads by training Hermes 4.3 both on Psyche and via the traditional centralized
approach. As outlined in the [Hermes 4\\
Technical Report](https://arxiv.org/pdf/2508.18255), we used our [custom version of\\
Torchitan](https://github.com/nousresearch/torchtitan/) to train Hermes 4.3 following the same recipe as Hermes 4
(FSDP+AdamW). We then trained the model a second time on Psyche (TP+DisTrO). Given
the extended context length and increased training set size, the Hermes 4.3 training
run was twice as large as Hermes 4.

![](https://nousresearch.com/wp-content/uploads/2025/12/43_12-1536x604.png)

![](https://nousresearch.com/wp-content/uploads/2025/12/43_22-1536x745.png)

The training run proved stable throughout, averaging 144k tokens/second spread across
24 Psyche nodes. Using DisTro’s overlapped collective strategy, the entirety of the
P2P communications were hidden by the training time, effectively achieving
equivalent throughput to traditional, centralized training. Under the hood, Psyche
uses a dual L1-P2P networking model where consensus state is managed by a smart
contract on the Solana blockchain while training gradients are communicated
out-of-band through a custom mesh P2P network.

![](https://nousresearch.com/wp-content/uploads/2025/12/43_34_2-1536x893.png)

**The Psyche trained version of Hermes 4.3 outperformed the traditional centralized**
**version on a suite of downstream tasks**. Although previous runs had produced
similar results, it was a confirming signal that Psyche is up to the task of
training production models. Hermes 4.3 achieves SOTA on RefusalBench across all
popular closed and open models in being helpful and aligned to the user’s values.
For transparency we are publishing the full set of [evaluation\\
responses and scorings](https://huggingface.co/datasets/NousResearch/eval-Hermes-4.3-36B). In addition we are releasing the centrally trained
version ( [🤗\\
Model](https://huggingface.co/NousResearch/Hermes-4.3-36B-centralized), [Evals](https://huggingface.co/datasets/NousResearch/eval-Hermes-4.3-36B-centralized))
as a research artifact (you’re welcome @xl8harder).

![](https://nousresearch.com/wp-content/uploads/2025/12/43_52-1536x842.png)

To learn more about Psyche, check out the [live\\
dashboard](https://psyche.network/) or the code on [GitHub](https://github.com/PsycheFoundation/psyche). You can also see
all transactions live on Solana on any block explorer ( [contract\\
address](https://explorer.solana.com/address/HR8RN2TP9E9zsi2kjhvPbirJWA1R6L6ruf4xNNGpjU5Y?cluster=devnet)).

We pride ourselves on Hermes going beyond standard math and coding benchmarks (which
we admit are easily gamed) and giving the user the broadest agency in exploration.
Enjoy, Hermes 4.3 36B:

![](https://nousresearch.com/wp-content/uploads/2025/12/43_62-1536x296.png)

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
- [API](https://portal.nousresearch.com/)
- [Psyche](https://nousresearch.com/nous-psyche/)
- [Hermes 4](https://hermes4.nousresearch.com/)
- [Nous\\
Chat](https://chat.nousresearch.com/)
- [Simulators](https://sims.nousresearch.com/)
- [Releases](https://nousresearch.com/releases/)
- [Careers](https://nousresearch.com/careers/)
- [Blog](https://nousresearch.com/blog/)
- [Shop](https://shop.nousresearch.com/)

```
NODES
```

[→ HuggingFace](https://huggingface.co/NousResearch)

[→\\
Discord](https://discord.gg/jqVphNsB4H)

[→ LinkedIn](https://www.linkedin.com/company/nousresearch/)

[→ Twitter](https://twitter.com/nousresearch)

[→ Email](https://nousresearch.com/cdn-cgi/l/email-protection#711a1003101f311f1e040203140214100312195f121e1c)

[→ GitHub](https://github.com/NousResearch)

[→ Careers](https://nousresearch.com/careers/)

[NOUS RESEARCH](https://nousresearch.com/)

THE AI ACCELERATOR COMPANY

NODES

[→ SIMULATORS](https://sims.nousresearch.com/)

[→ NOUS BLOG](https://nousresearch.com/blog)

[→\\
HuggingFace](https://huggingface.co/NousResearch)

[→ Discord](https://discord.gg/jqVphNsB4H)

[→ LinkedIn](https://www.linkedin.com/company/nousresearch/)

[→ Twitter](https://twitter.com/nousresearch)

[→\\
Email](https://nousresearch.com/cdn-cgi/l/email-protection#177c766576795779786264657264727665747f3974787a)

[→ GitHub](https://github.com/NousResearch)