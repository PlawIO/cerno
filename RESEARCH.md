# AgentCaptcha Competitive Research
**Date:** 2026-03-28
**Working name:** 007captcha

---

## Table of Contents
1. [Current CAPTCHA Landscape](#1-current-captcha-landscape)
2. [AI Browser Agent Capabilities 2025-2026](#2-ai-browser-agent-capabilities-2025-2026)
3. [Academic Research on Human-vs-Bot Detection](#3-academic-research-on-human-vs-bot-detection)
4. [Canvas/Drawing-Based Verification](#4-canvasdrawing-based-verification)
5. [Maze Generation Algorithms](#5-maze-generation-algorithms)
6. [Mouse/Touch Dynamics as Biometrics](#6-mousetouch-dynamics-as-biometrics)
7. [Anti-Agent Techniques](#7-anti-agent-techniques)
8. [Proof-of-Work Alternatives](#8-proof-of-work-alternatives)
9. [Synthesis and Strategic Implications](#9-synthesis-and-strategic-implications)

---

## 1. Current CAPTCHA Landscape

### Market Share (March 2026)

Source: Aguko tracking across 11.1M websites, 59 CAPTCHA technologies.

| Provider | Market Share |
|----------|-------------|
| reCAPTCHA (Google) | 43.85% |
| HSTS | 23.66% |
| Cloudflare Bot Management | 17.74% |
| Akamai Bot Manager | 7.20% |
| Akamai WAP | 3.32% |
| Sucuri | 1.60% |
| Imperva | 0.54% |
| DataDome | 0.36% |
| hCaptcha | 0.33% |
| Cloudflare Turnstile | 0.27% |
| GeeTest, Arkose Labs, Friendly Captcha | <0.01% each |

**Key insight:** The top 5 technologies cover 92% of the market. Google dominates with nearly half of all implementations despite widespread criticism of its privacy model.

### How Each Major Provider Works

**reCAPTCHA v3 (Google)**
- Fully invisible. Monitors mouse tracks, device features, browsing rhythm.
- Assigns risk scores 0.0-1.0. Low-risk users pass silently; high-risk triggers fallback challenges.
- Weakness: Requires Google cookies/tracking. False positives on privacy-focused browsers. Specialized solver services achieve 90%+ bypass rates through full browser environment simulation and token generation.
- Source: GeeTest comparison, CapSolver research

**Cloudflare Turnstile**
- Uses proof-of-work, proof-of-space challenges, Web API probing, and browser-quirk detection.
- Invisible to most users. No image challenges.
- Weakness: Relies on Cloudflare infrastructure; cannot be self-hosted. Stealth browsers with real TLS stacks can sometimes pass.
- Source: GeeTest comparison, Cloudflare docs

**hCaptcha**
- Privacy-preserving ML to identify bot behavior through image labeling tasks.
- Adapts automatically to emerging attack patterns. Multiple rounds of image selection.
- Weakness: User friction from repeated image selection. ML-solvable with specialized services.
- Source: GeeTest comparison

**Arkose Labs (FunCaptcha)**
- Interactive 3D challenges: image rotation, gender classification, object manipulation.
- Designed specifically to defeat automated solving through 3D rendering.
- Weakness: Accessibility nightmares. High user friction. Expensive.
- Source: GeeTest comparison

**GeeTest Adaptive CAPTCHA**
- Refreshes 300,000 verification images hourly. Analyzes drag trajectories and hesitation patterns.
- Adaptive strategies per-request.
- Weakness: Small market share. Limited ecosystem integration.
- Source: GeeTest own documentation

**Friendly Captcha / ALTCHA / Cap.js**
- Pure proof-of-work approaches using SHA-256. Invisible, privacy-first.
- Weakness: Device performance variability. PoW alone doesn't stop sophisticated bots -- just makes them more expensive. No behavioral signal.
- Source: ALTCHA docs, GeeTest PoW analysis

### CAPTCHA Solving Industry (2026)

A thriving bypass industry exists with services like CapSolver, 2Captcha, CapMonster Cloud, and uCaptcha. Key findings:

- Specialized solver services achieve **90%+ success rates** through full browser environment simulation and token generation
- General-purpose AI agents (not specialized solvers) achieve only 20-60% success rates
- The solving industry costs $0.50-$3.00 per 1000 reCAPTCHA v2 solves
- Fastest services resolve reCAPTCHA in 10-15 seconds average

**Critical insight for our product:** The distinction between *general AI agents* and *specialized solver services* matters enormously. General agents struggle; specialized services don't. Our CAPTCHA must resist both threat models.

Sources:
- https://www.geetest.com/en/article/best-captcha-providers
- https://www.capsolver.com/blog/web-scraping/2026-ai-agent-captcha
- https://www.aguko.com/cat/captchas
- https://scrapfly.io/blog/posts/best-captcha-solving-api

---

## 2. AI Browser Agent Capabilities 2025-2026

### The Agent Landscape

Two distinct architectures have emerged:

**Vision-based agents** (screenshot-driven):
- Claude Computer Use, OpenAI Operator, Manus AI
- Capture screenshots, reason about visual content, execute actions
- Workflow: Observe (screenshot) -> Think (reason) -> Act (click/type) -> Repeat
- Can adapt to UI changes since they interpret visuals, not DOM selectors

**DOM-based agents** (accessibility tree / HTML):
- Playwright MCP, Stagehand, Steel.dev
- Parse accessibility snapshots or HTML structure directly
- Faster execution (no vision model inference)
- More brittle when sites redesign

**Hybrid agents:**
- Browser-use, Hyperbrowser AI, Anchor Browser
- Combine vision with DOM access for reliability

### Key Players and Performance

| Agent | Architecture | Browser Task Success | Notes |
|-------|-------------|---------------------|-------|
| OpenAI Operator | Vision | 87% (browser automation) | $200/month. Cloud-hosted. Prioritizes safety with user confirmation. |
| Claude Computer Use | Vision + Desktop | 56% (browser), 58% (WebVoyager) | $18-20/month. Controls browsers AND desktop apps. Requires Docker. |
| Manus AI | Multi-modal + sandbox | High autonomy | Combines vision + language + code execution |
| Playwright MCP | DOM/Accessibility | Task-dependent | Uses accessibility snapshots, not screenshots. Fastest. |
| Stagehand v3 | Hybrid | 44% faster than v2 | AI-native rewrite for speed |
| Chrome + Gemini | Vision | Varies | Turns Chrome into autonomous agent |

Source: o-mega.ai review, AgentRank comparison, NoHacks agentic browser guide

### What Agents Can Do
- Navigate websites autonomously
- Fill forms, click buttons, extract data
- Complete multi-step workflows (booking, shopping, research)
- Handle authenticated sessions and multi-tab workflows
- Adapt to UI changes (vision-based agents)

### What Agents Cannot Do (Reliably)
- **Solve CAPTCHAs consistently** -- even the best (Claude) only achieves 60% on reCAPTCHA v2
- **Handle cross-tile image challenges** -- 0-1.9% success rate across all models
- **React to dynamic content changes** -- reload challenges cause failure loops
- **Produce natural mouse/keyboard behavior** -- movements are "too direct, lack natural jitter"
- **Manage invisible tokens** -- cannot extract/manage/submit validation tokens
- **Handle infinite scroll** -- no pagination anchor
- **Process hover-dependent content** -- hover states missed

### Speed Characteristics
- Vision-based agents: 2-5 seconds per action (screenshot capture + model inference + execution)
- DOM-based agents: Sub-second per action
- Human browsing: ~1-3 seconds per interaction on average
- **Implication for us:** Any CAPTCHA requiring sustained, real-time interaction over multiple seconds with continuous behavioral measurement will punish the latency of vision-based agents.

### The Roundtable Benchmark (Oct 2025)

The most rigorous published benchmark of AI vs reCAPTCHA v2. 75 trials per model, 388 total attempts.

| CAPTCHA Type | Claude 4.5 | Gemini 2.5 Pro | GPT-5 |
|-------------|------------|----------------|-------|
| Static (3x3) | 47.1% | 56.3% | 22.7% |
| Reload (dynamic) | 21.1% | 13.3% | 2.1% |
| Cross-tile (4x4) | 0.0% | 1.9% | 1.1% |
| **Overall** | **60%** | **56%** | **28%** |

**Critical finding:** "For humans, Cross-tile is easier than Static or Reload." This is a fundamental perceptual gap. Humans excel at cross-boundary object recognition; AI fails because it attempts "perfectly rectangular selections" and cannot handle partial/occluded/boundary-spanning objects.

**GPT-5 failure mode:** Excessive "Thinking" tokens and "obsessive" clicking/unclicking caused timeouts. "More reasoning isn't always better...sometimes, overthinking is just another kind of failure."

Sources:
- https://research.roundtable.ai/captcha-benchmarking/
- https://gigazine.net/gsc_news/en/20251116-gpt-5-gemini-claude-captcha/
- https://www.agentrank.tech/blog/openai-operator-vs-claude-computer-use
- https://groundy.com/articles/browser-use-agents-ai-that-browses-like/

---

## 3. Academic Research on Human-vs-Bot Detection

### Key Papers and Findings

**"CAPTCHA farm detection via mouse-trajectory similarity" (Springer, Aug 2025)**
- Compares mouse trajectories across CAPTCHA sessions to detect farms (where challenges are relayed to remote human solvers)
- Uses trajectory similarity metrics to identify when the same person is solving challenges for different sessions
- Addresses a gap that behavioral biometrics alone cannot: human-powered CAPTCHA farms

**"Spatial CAPTCHA: Generatively Benchmarking Spatial Reasoning" (ICLR 2026 submission)**
- Procedurally generates spatial reasoning challenges (geometric reasoning, perspective-taking, occlusion, mental rotation)
- Best AI model: only **31.0% Pass@1** accuracy across 10 SOTA multimodal LLMs
- Humans vastly outperform AI on spatial tasks
- **Key insight: Spatial reasoning is a durable human advantage.** Unlike text/image recognition (where AI has caught up), spatial understanding remains a significant gap.

**"Web Bot Detection Using Mouse Movement" (IEEE, 2025)**
- Confirms mouse movement patterns as reliable bot discriminator
- Bot movements show sharp, linear patterns with convergence points vs. organic, dense human patterns

**"Detecting Web Bots via Keystroke Dynamics" (SEC 2024)**
- Keystroke timing patterns distinguish bots from humans
- Features: dwell time, flight time, digraph latency
- Bots show unnaturally uniform timing patterns

**"Integrating user demographic parameters for mouse behavioral biometric-based assessment fraud detection" (Springer, Jul 2025)**
- Mouse behavioral biometrics for fraud detection in education platforms
- Demographic parameters (age, experience) affect mouse behavior baselines

**"Balancing Security and Privacy: Web Bot Detection" (Open Research Europe, Mar 2025)**
- Surveys privacy challenges of behavioral bot detection under GDPR and EU AI Act
- Behavioral signals create privacy tension -- collecting mouse data = collecting personal data
- GDPR-compliant approaches need purpose limitation and data minimization

### Roundtable "Proof of Human" Research (Jun 2025)

This is the most directly relevant academic work for our use case.

**Core thesis:** AI systems have detectable behavioral signatures that can be used for bot detection.

**Signals measured:**
- Keystroke dynamics (timing irregularities between key presses and releases)
- Mouse movements (micro-adjustments, overshoots, corrections)
- Click behavior patterns
- Scroll tracking

**Key findings:**
1. Human typing is "irregular and context-dependent"; bots "paste text instantly or simulate key-by-key typing with unnatural regularity"
2. Human mouse movement involves "micro-adjustments, overshoots, and corrections"; bots "move in straight lines or teleport between points"
3. OpenAI Operator exhibits "perfectly centered mouse clicks and repeatedly pasted text" -- yet still passes reCAPTCHA v3. **This reveals a critical gap in current CAPTCHA detection.**

**The Stroop Task insight:** Roundtable uses psychology's Stroop Task (identify word colors while ignoring word meaning). Humans show measurably slower responses during incongruent stimuli (cognitive interference). AI responds with consistent speed regardless. This is a **cognitive signature** that is fundamentally hard for AI to fake because it requires simulating human cognitive processing delays.

**Cost complexity argument:** Spoofing continuous behavioral signatures requires more effort than other fraud methods. This is the economic moat for behavioral detection.

Sources:
- https://research.roundtable.ai/proof-of-human/
- https://research.roundtable.ai/captcha-benchmarking/
- https://ui.adsabs.harvard.edu/abs/2025arXiv251003863K/abstract
- https://link.springer.com/article/10.1007/s00530-025-01897-0
- https://ieeexplore.ieee.org/document/10205593/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11962364/

---

## 4. Canvas/Drawing-Based Verification

### Existing Implementations

**Drawing Captcha (drawing-captcha.com / GitHub)**
- Open-source Node.js/Express/MongoDB system
- Users complete interactive drawing tasks (custom patterns, brand logos, geometric designs)
- JWT token-based session management (5-minute expiry)
- npm package: `@drawing-captcha/drawing-captcha-frontend`
- **Weakness:** No documented bot resistance testing. No published validation algorithm details. No behavioral analysis of *how* the user draws -- only *what* they draw. This is a massive gap.
- Source: https://drawing-captcha.com, GitHub

**Sketcha (Princeton/Michigan, WWW 2010)**
- CAPTCHA based on line drawings of 3D models
- Users identify which line drawing corresponds to a real 3D object
- Academic proof-of-concept, never widely deployed
- Predates modern vision AI, likely trivially solvable now
- Source: https://jhalderm.com/pub/papers/sketcha-www10.pdf

**ShapeCaptcha (GitHub, 2017)**
- Canvas-based "draw a shape" verification
- 4 GitHub stars. Essentially abandoned.
- Source: https://github.com/serglider/ShapeCaptcha

**GAPTCHAs (ISEA 2025)**
- "Playful Exploration of the Limitations of Human Verification"
- Art/design research exploring CAPTCHA as creative medium
- Not a security product
- Source: https://raylc.org/chairbots/GAPTCHAS_ISEA2025_Prepub.pdf

### What Worked

- Drawing tasks are engaging and low-friction compared to image selection
- Canvas interactions produce rich behavioral data (pressure, speed, timing, stroke order)
- Brand-customizable verification creates dual value (security + marketing)

### What Failed

- No existing implementation analyzes *how* the user draws (behavioral signals during the drawing)
- All existing systems focus on recognizing *what* was drawn, which is vision-AI-solvable
- No adversarial testing against modern AI agents
- No published work on drawing-based CAPTCHA that uses continuous behavioral biometrics during the drawing process

### Applicability to AgentCaptcha

**This is our primary opportunity gap.** No one has built a drawing/maze CAPTCHA that:
1. Measures continuous behavioral signals during the interaction (not just the final output)
2. Applies mouse/touch dynamics analysis to the drawing/solving process
3. Tests specifically against AI browser agents (vision-based and DOM-based)
4. Combines the task difficulty of spatial reasoning with the behavioral richness of continuous motor control measurement

The "what" of the challenge (drawing, maze-solving) provides a **visible task** that humans find intuitive. The "how" of the interaction (motor dynamics, timing, cognitive signatures) provides the **invisible detection layer** that AI cannot fake.

Sources:
- https://drawing-captcha.com/
- https://github.com/Drawing-Captcha/Drawing-Captcha-APP
- https://github.com/serglider/ShapeCaptcha
- https://jhalderm.com/pub/papers/sketcha-www10.pdf

---

## 5. Maze Generation Algorithms

### Algorithm Overview

**Recursive Backtracker (Randomized DFS)**
- Deep, winding passages with long corridors
- Few but long dead ends
- High "river" factor (long, flowing paths)
- Human perception: Medium difficulty. Satisfying to solve due to clear forward progress.

**Randomized Prim's Algorithm**
- Short, branching passages
- Many dead ends of varying length
- Low bias, more uniform appearance
- Human perception: Harder than DFS mazes at same size due to frequent decision points.

**Randomized Kruskal's Algorithm**
- Similar to Prim's but generates more isolated-looking passages
- Random-feeling layout
- Human perception: Moderate difficulty.

**Growing Tree Algorithm**
- Configurable behavior: can emulate DFS (stack-like), Prim's (queue-like), or hybrid
- Breadth-first variant produces wide, spreading passages
- Most flexible for difficulty tuning
- Source: https://www.miklix.com/mazes/maze-generators/growing-tree

**Eller's Algorithm**
- Row-by-row generation. Memory-efficient.
- Can generate infinite mazes
- Human perception: Moderate. Row structure creates directional bias.

### Difficulty Parameters

From the academic literature (ACG 2021, Earlham College research):

**Parameters that correlate with human-perceived difficulty:**
1. **Solution path length** -- longer paths = harder (obvious)
2. **Dead-end frequency and depth** -- more/deeper dead ends = harder
3. **Decision point density** -- more forks = harder
4. **Solution path directness** -- ratio of Euclidean distance to path length; less direct = harder
5. **Intersection complexity** -- 3-way vs 4-way junctions affect cognitive load

**Parameters for a "human-friendly but AI-hard" maze:**
- Small enough to solve visually in <10 seconds (7x7 to 12x12 grid recommended)
- Multiple viable-looking paths (high decision density) that require spatial planning
- Curved or diagonal passages that are hard to parse from a screenshot
- **Critical: The maze is not the real challenge.** The behavioral data collected *during maze solving* is the actual signal.

### LLM Maze-Solving Capabilities

**AlphaMaze (Feb 2025)** tested LLM maze-solving ability:
- Untrained LLMs: **0% accuracy** on maze navigation (MazeBench)
- After SFT (supervised fine-tuning): 86.0% on 5x5 mazes
- After SFT + GRPO reinforcement learning: 93.0% on 5x5 mazes
- Even trained models struggle with "mazes requiring backtracking or more complex spatial planning"
- **Tested on text-represented mazes, not visual mazes**

**GPT-4 Path Planning (2024):** LLMs face "challenges with long-horizon planning" in maze/path tasks.

**SPaRC (EMNLP 2025):** Spatial Pathfinding Reasoning Challenge shows LLMs struggle with spatial pathfinding.

**Implication:** For a visual maze CAPTCHA:
- Vision-based agents must: screenshot the maze -> reason about paths -> plan a route -> execute mouse movements along the path
- This is a multi-step pipeline with latency at each stage
- A 10x10 maze with 2-3 decision points is trivially solvable by a human in 5-8 seconds
- The same maze requires significant reasoning from an AI agent, producing detectable latency and movement patterns

### Maze Properties That Maximize Human-AI Gap

1. **Visual parsing difficulty:** Thin walls, overlapping paths, subtle openings that are easy for human peripheral vision but hard for screenshot-based reasoning
2. **Dynamic elements:** Walls that appear/disappear, requiring real-time adaptation
3. **Multi-path solutions:** Multiple valid solutions reduce the "correct answer" to a behavioral measurement rather than a binary pass/fail
4. **Curved passages:** Humans navigate curves naturally; vision AI processes grids
5. **Size sweet spot:** 8x8 to 12x12 -- large enough to require planning, small enough for <10 second human solve time

Sources:
- https://icga.org/wp-content/uploads/2021/11/ACG_2021_paper_27.pdf
- https://en.wikipedia.org/wiki/Maze_generation_algorithm
- https://arxiv.org/html/2502.14669v1
- https://aclanthology.org/2025.emnlp-main.526.pdf
- https://nbviewer.org/github/norvig/pytudes/blob/main/ipynb/Maze.ipynb

---

## 6. Mouse/Touch Dynamics as Biometrics

### Feature Taxonomy (from Khan et al. survey, arXiv 2208.09061)

**Movement-based (highest discriminative power):**
- Traveled distance and curve length
- Straightness/efficiency (ratio of straight-line to actual path distance)
- Velocity (instantaneous and average)
- Acceleration (first derivative of velocity)
- Jerk (second derivative of velocity, third derivative of position)
- Curvature (rate of direction change)

**Temporal features:**
- Elapsed time between events
- Pause duration and frequency
- Click duration (dwell time)
- Double-click interval

**Geometric features:**
- Angular velocity
- Direction changes per unit distance
- Offset from straight-line path

**Statistical derivatives (applied to above features):**
- Mean, standard deviation, skewness, kurtosis
- Min, max, range
- Percentile distributions

### Accuracy Rates

| Study | Approach | Best Result |
|-------|----------|-------------|
| Shen et al. | Fixed tasks, SVM | EER 2.64% |
| Competitive study | Continuous auth | FAR 0.37%, FRR 1.12% |
| Free-task scenarios | Various | EER ~40% (dramatically worse) |

**Critical caveat:** Performance degrades dramatically in uncontrolled (free-task) environments. A CAPTCHA is a *controlled task* by definition -- this works in our favor.

### Bot vs Human: Key Distinguishing Signals

From Bureau.id analysis and the mouse dynamics survey:

| Signal | Human Behavior | Bot Behavior |
|--------|---------------|-------------|
| Movement pattern | Organic, dense, circular/elliptical | Sharp, linear, geometric with convergence points |
| Spatial distribution | Broad, diffused heat concentration | Tightly focused hotspots along straight lines |
| Displacement | Gaussian distribution centered ~300-400px | Bimodal: micro-adjustments + abrupt jumps >800px |
| Direction | Wide, nearly uniform angular distribution | Sharp peaks at fixed angles (0, +-pi/2, +-pi) |
| Path efficiency | Peaks at 0.3-0.4 (exploratory) | 0.05-0.2 (direct, optimized) |
| Timing | Wide range with irregular pauses | Narrow window, clustered pauses |
| Speed | Broad range, concentrated at slower speeds | Oscillates between low-speed spikes and sudden high-speed transitions |

### The WindMouse Problem

WindMouse (ben.land, 2021) is a physics-based algorithm for generating "human-like" mouse motion using gravity (pull toward target) and wind (random perturbation) forces. Parameters: gravitational force G0=9, wind fluctuation W0=3, max velocity M0=15, behavior change threshold D0=12.

**What it gets right:** Curved paths, overshoot-and-correct behavior, variable speed profiles.

**What it gets wrong:** Statistical distribution doesn't perfectly match real human data. Lacks micro-tremor, doesn't model Fitts' Law correctly, no cognitive pause modeling.

**Implication for us:** Sophisticated bots *will* use WindMouse-like algorithms. Our detection must go beyond first-order movement features (speed, direction) to higher-order features (jerk, curvature change rate, Fitts' Law compliance, cognitive pause patterns at decision points).

### Fitts' Law as Detection Signal

Fitts' Law: Movement time = a + b * log2(2D/W), where D is distance to target and W is target width.

Humans universally follow Fitts' Law when pointing. The speed-accuracy tradeoff is a fundamental property of biological motor systems. Bots using linear interpolation or even WindMouse don't naturally produce Fitts-compliant movement times.

**High-value detection approach:** Design the maze/drawing task with targets of varying size and distance. Measure whether the user's movement times follow Fitts' Law regression. Deviation from Fitts' Law = strong bot signal.

### Touch-Specific Signals (Mobile)

- Pressure variation during continuous touch movement
- Touch contact area changes during turns/acceleration
- Gyroscope/accelerometer data during interaction
- Multi-touch ghost touches from hands resting on screen

Sources:
- https://arxiv.org/html/2208.09061v2
- https://bureau.id/resources/blog/mouse-movement-behavioral-patterns-can-reliably-tell-bots-from-humans
- https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/
- https://www.scirj.org/papers-0420/scirj-P0420766.pdf

---

## 7. Anti-Agent Techniques

### Detection Signals by Category

**Browser Environment Fingerprinting:**

| Signal | Detection Method | Evasion Difficulty |
|--------|-----------------|-------------------|
| navigator.webdriver | Check if property exists and is configurable | Low (easily patched) |
| CDP serialization | Trigger object serialization that only occurs with CDP active | Medium (requires protocol-level evasion) |
| Chrome DevTools Protocol artifacts | Runtime.consoleAPICalled events, __pw* globals | Medium |
| Canvas fingerprint consistency | Same seed must produce identical results across calls | High (random noise injection fails) |
| WebGL renderer string | Must match actual GPU capabilities | High (cross-signal consistency required) |
| Audio context fingerprint | Web Audio API produces hardware-specific frequency data | High (requires real audio stack) |
| Font enumeration | Headless browsers have minimal font sets | Medium |
| TLS fingerprint (JA3/JA4) | Python HTTP libs have distinct TLS signatures | High (requires real browser) |

**Behavioral Signals:**

| Signal | What It Detects | Future-Proof? |
|--------|----------------|---------------|
| Mouse movement linearity | Bots move in straight lines | Medium -- WindMouse exists |
| Click position centering | Bots click element centers perfectly | Medium -- easy to add jitter |
| Event ordering | Real clicks: mousemove->mousedown->mouseup->click | Medium -- but edge cases persist |
| Timing between actions | Bots have consistent timing | Medium -- random delays added |
| Keystroke cadence | Human typing follows log-normal distribution | High -- hard to simulate well |
| Cognitive interference patterns | Stroop-like delays in conflicting stimuli | Very High -- requires simulating cognition |
| Fitts' Law compliance | Biological motor system signature | High -- requires physics modeling |
| Scroll velocity patterns | Human scrolling has momentum/inertia | Medium |

**FCaptcha v1.3 Detection Specifics (proven):**
- `__pw*` and `__playwright*` window properties (score: 0.95)
- Deleted navigator.webdriver (score: 0.80)
- Configurable descriptor on navigator.webdriver (score: 0.70)
- Missing chrome.runtime (score: 0.60)
- Keystroke cadence: dwell variance, log-normal fit, uniformity detection, lag-1 autocorrelation, burst regularity, Shannon entropy, rollover rate
- Requires 20+ keystrokes and 15+ intervals before analysis activates

Source: https://webdecoy.com/blog/fcaptcha-v1-3-keystroke-cadence-biometrics-playwright-detection/

### The Coherence Problem (Most Important Detection Concept)

The single most reliable detection approach in 2025-2026 is **cross-signal coherence checking**:

- Canvas hash must match WebGL renderer claims
- GPU strings must align with screen resolution capabilities
- CPU core counts must match performance benchmarks
- Font lists must correspond to reported OS platform
- Movement dynamics must be consistent with reported input device
- Timing patterns must be consistent across all interaction types

**Any single signal can be faked. Faking coherence across dozens of signals simultaneously is exponentially harder.**

### The Anti-Detect Framework Arms Race

**Evolution timeline:**
1. Puppeteer-stealth (2018-2022): JavaScript-level API patching via proxies
2. Chrome headless unification (Nov 2022): Eliminated headful/headless fingerprint differences
3. CDP-minimal approaches (2023-present): Nodriver, Selenium Driverless avoid CDP domains
4. OS-level input simulation (2024-present): Bypass CDP entirely via OS input events

**Current commercial anti-detect browsers:** Multilogin, GoLogin, AdsPower, Kameleo, Dolphin Anty -- all include automation hooks.

**What still works for detection:**
- CDP serialization artifacts in console interactions
- Protocol-level patterns differing from genuine user sessions
- Behavioral inconsistencies when patching is applied naively
- Cross-signal coherence failures

### What's Future-Proof Against Faster LLMs

Techniques that depend on **what the AI knows or can reason about** will eventually fail as models improve. Techniques that depend on **physical properties of biological motor systems** are more durable:

**Will NOT survive faster LLMs:**
- Image recognition challenges (already mostly solved)
- Text-based CAPTCHAs (trivial)
- Simple logic puzzles (reasoning improves continuously)
- Static fingerprint checks (stealth tools catch up)

**WILL survive faster LLMs (at least medium-term):**
- Continuous behavioral biometrics during interaction (requires real-time motor control, not reasoning)
- Cross-signal coherence (complexity scales exponentially)
- Cognitive interference patterns (Stroop effect -- would require AI to deliberately slow down in specific ways)
- Fitts' Law compliance (fundamental biomechanics)
- Latency constraints (vision-based agents need seconds per action; humans act in milliseconds)

Sources:
- https://blog.castle.io/from-puppeteer-stealth-to-nodriver-how-anti-detect-frameworks-evolved-to-evade-bot-detection/
- https://kelaax.com/blog/webgl-canvas-fingerprinting-deep-dive
- https://use-apify.com/blog/web-scraping-anti-detection-2026
- https://blog.castle.io/bot-detection-101-how-to-detect-bots-in-2025-2/
- https://dev.to/digitalgrowthpro/understanding-browser-automation-detection-a-technical-deep-dive-for-developers-l4a

---

## 8. Proof-of-Work Alternatives

### Existing PoW CAPTCHA Systems

**Cap.js (GitHub, 5.1k stars)**
- SHA-256 proof-of-work, privacy-first, self-hosted
- Lightweight, open-source alternative
- No behavioral analysis component
- Source: https://git.new/capjs

**ALTCHA**
- Server generates random salt + secret number, applies SHA-256
- Client iterates through numbers until finding matching hash
- `maxnumber` parameter controls difficulty (higher = more CPU work)
- Privacy: no external services, client-side processing only
- Submits BASE64-encoded JSON with algorithm, challenge, number, salt, signature
- Source: https://altcha.org/docs/v2/proof-of-work-captcha/

**Friendly Captcha**
- Commercial PoW CAPTCHA with algorithm variance control
- Invisible, privacy-preserving
- Source: https://friendlycaptcha.com

**powCAPTCHA**
- "Next-gen" PoW approach
- Privacy-first, invisible
- Source: https://powcaptcha.com

**mCaptcha**
- Open-source, self-hosted PoW
- HN discussion (2023) showed community interest
- Source: https://news.ycombinator.com/item?id=37054670

### How PoW Economics Work

| Factor | Legitimate User | Bot Farm |
|--------|----------------|----------|
| Requests/hour | 1-10 | 1,000-1,000,000 |
| Compute cost | Negligible (1 challenge) | Linear scaling (every request = CPU work) |
| Hardware investment | None | Proportional to throughput |
| Profitability impact | None | Erodes margins |

**PoW creates a cost floor:** Each request requires measurable computation. Legitimate users barely notice; bot farms face linear infrastructure costs that erode profitability of credential stuffing, account creation, etc.

### ThermoCAPTCHA (arXiv, Mar 2026) -- Novel Approach

A radical departure from all existing approaches:

- Uses **thermal imaging** to detect live human presence
- YOLOv4-tiny identifies human heat signatures from single thermal capture
- 96.70% detection accuracy, 73.60ms verification latency
- **Farm-resistant traceable tokens**: Cryptographically bound to session ID, device fingerprint, nonce, timestamp. 0% success rate across 1,600 reuse attempts.
- Privacy-preserving: thermal images don't identify individuals
- User study (50 participants): 94.70% accuracy in 6.56 seconds vs 82.50% in 13.32s for reCAPTCHA
- Visually challenged participants: 96.77% accuracy vs 70.59% for reCAPTCHA

**Limitation:** Thermal cameras aren't standard on consumer devices. Falls back to traditional CAPTCHA without hardware.

**Key takeaway for us:** The farm-resistant token design is interesting regardless of thermal imaging. Cryptographically binding tokens to session + device + timestamp prevents token relay attacks.

### PoW Limitations as Standalone Defense

GeeTest's analysis is clear: PoW "is not a standalone solution." Reasons:

1. **Device performance variability** -- Mobile/low-power devices penalized
2. **Context insensitivity** -- High legitimate traffic looks the same as attacks
3. **Not a blocking mechanism** -- Only slows, doesn't stop
4. **No intent detection** -- A determined attacker can simply provision more compute

### Optimal PoW Strategy

PoW works best as one layer in a multi-layer system:
- **Risk-based activation** -- Only trigger when traffic is suspicious
- **Dynamic difficulty** -- Scale challenge based on assessed risk
- **Combined with behavioral signals** -- PoW handles economics; behavioral analysis handles intent

Sources:
- https://altcha.org/docs/v2/proof-of-work-captcha/
- https://www.geetest.com/en/article/proof-of-work-captcha
- https://arxiv.org/html/2603.05915
- https://friendlycaptcha.com/insights/proof-of-work-captcha/
- https://git.new/capjs

---

## 9. Synthesis and Strategic Implications

### The Core Insight

Every existing CAPTCHA system falls into one of two categories:
1. **Challenge-based** (solve this puzzle) -- being defeated by improving AI vision/reasoning
2. **Behavioral-based** (act like a human) -- more durable but currently invisible/passive only

**No one is combining a visible interactive challenge with continuous behavioral biometric measurement.** This is the AgentCaptcha opportunity.

### What Makes AI Agents Fundamentally Detectable

Three properties of current AI browser agents create inherent, difficult-to-fake signatures:

1. **Latency budget**: Vision-based agents need 2-5 seconds per action (screenshot + inference + execution). During a 10-second maze solve, a human makes hundreds of continuous micro-movements. An agent makes 3-5 discrete actions with dead time between them.

2. **Motor control fidelity**: Even with WindMouse-like algorithms, AI-generated movement lacks:
   - Fitts' Law compliance (speed-accuracy tradeoff)
   - Micro-tremor from biological noise
   - Cognitive pause patterns at decision points
   - Cross-modal consistency (mouse speed correlating with maze complexity)
   - Natural jerk profiles (third derivative of position)

3. **Cognitive signatures**: Humans show measurable cognitive interference effects (Stroop effect, decision hesitation at forks, exploration patterns). AI agents either act too consistently or too randomly -- they don't show the specific patterns of human uncertainty.

### The "Proven vs Theoretical" Matrix

| Approach | Status | Evidence Level |
|----------|--------|---------------|
| reCAPTCHA v2 image challenges | Proven defeatable | AI hits 60% overall, but 0% on cross-tile |
| Mouse movement analysis for bot detection | Proven effective | Multiple papers, commercial deployment (Castle.io, Bureau.id) |
| Keystroke dynamics for bot detection | Proven but bypassable | FCaptcha, IsHumanCadence -- client-side is "trustless" |
| Spatial reasoning as AI-hard task | Proven gap | Spatial CAPTCHA: best AI = 31% vs human >>90% |
| Maze solving by LLMs | Proven hard | 0% untrained, 93% on 5x5 text mazes after training, visual mazes untested |
| Cross-signal coherence checking | Proven effective | Industry standard for bot detection |
| PoW for economic deterrence | Proven for volume | Cap.js, ALTCHA, Friendly Captcha all deployed |
| Drawing + behavioral biometrics CAPTCHA | **Theoretical -- untested** | No existing implementation combines these |
| Fitts' Law compliance detection | Theoretical | Research supports the principle; no CAPTCHA deployment |
| Cognitive interference detection | Theoretical | Stroop task validated; not deployed in CAPTCHA context |

### Five "Eureka" Insights

1. **The maze is a Trojan horse.** The visible challenge (solve the maze) is not the real test. The real test is the continuous stream of behavioral biometric data produced during solving. The maze gives humans a fun, intuitive task while generating the richest possible behavioral signal. An AI agent can potentially solve the maze (the "what") but cannot convincingly fake the motor dynamics of solving it (the "how").

2. **Cross-tile reCAPTCHA has 0% AI success -- and humans find it easy.** This proves that "easy for humans, hard for AI" is achievable TODAY without exotic technology. The gap exists in spatial/perceptual tasks, not in raw reasoning.

3. **Client-side behavioral analysis is "trustless" -- but that doesn't matter if the task requires real-time continuous interaction.** IsHumanCadence was defeated because bots can inject fake keystrokes. But during a maze-solving task that requires continuous mouse movement along a specific path in real time, the bot must generate a plausible continuous trajectory that follows the maze walls, shows Fitts' Law compliance, includes cognitive pauses at decision points, and matches human jerk profiles -- all while actually navigating the correct path. This is orders of magnitude harder than injecting fake keystrokes.

4. **The speed gap is permanent (for vision-based agents).** Even if future LLMs reason 10x faster, the fundamental architecture of vision-based agents (screenshot -> inference -> action) creates a step-function latency that produces dead time in the behavioral stream. DOM-based agents are faster but produce NO behavioral data by default -- they'd need to synthesize it, which brings us back to the faking problem.

5. **PoW + behavioral + spatial reasoning = triple moat.** Each layer addresses a different threat:
   - PoW addresses bot farm economics (cost floor per attempt)
   - Behavioral analysis addresses sophisticated automation (motor control fidelity)
   - Spatial reasoning task addresses AI reasoning capability (durable human advantage)
   - An attacker must defeat all three simultaneously.

### Direct Applicability to AgentCaptcha Design

**Recommended architecture:**

```
Layer 1: Invisible PoW
  - SHA-256 challenge runs in background during page load
  - Dynamic difficulty based on IP reputation / request patterns
  - Raises cost floor for bot farms

Layer 2: Interactive Maze Challenge
  - Procedurally generated maze (8x8 to 12x12)
  - Growing Tree algorithm for tunable difficulty
  - Curved passages, variable wall thickness
  - Multiple valid solutions (any path = correct)
  - Human solve time target: 5-8 seconds

Layer 3: Continuous Behavioral Analysis (invisible to user)
  During maze solving, measure:
  - Mouse velocity, acceleration, jerk profiles
  - Fitts' Law compliance at turns and openings
  - Cognitive pause patterns at decision points
  - Path efficiency ratio
  - Angular velocity distribution (uniform = human, peaked = bot)
  - Micro-tremor and noise floor
  - Movement onset latency (too fast = bot, too slow = vision agent)
  - Cross-signal coherence with browser fingerprint

Layer 4: Server-Side Validation
  - Token cryptographically bound to session + device + timestamp
  - Behavioral score computed server-side (client sends raw events)
  - Farm detection via trajectory similarity across sessions
  - Rate limiting per behavioral signature (not just IP)
```

### Competitive Positioning

| Competitor | What They Do | What We Do Differently |
|-----------|-------------|----------------------|
| reCAPTCHA v3 | Invisible behavioral scoring | We add an interactive spatial task that generates richer behavioral data |
| Cloudflare Turnstile | PoW + browser fingerprinting | We add continuous motor control analysis during interactive task |
| hCaptcha | Image labeling challenges | We replace solvable image tasks with spatial maze + behavioral layer |
| Arkose Labs | 3D interactive challenges | We focus on behavioral measurement, not challenge difficulty |
| Friendly Captcha | Pure PoW | We add behavioral + spatial layers |
| Drawing Captcha | Drawing verification | We analyze HOW they draw, not WHAT they drew |

### Open Questions for Further Research

1. What is the minimum interaction duration needed for reliable behavioral classification?
2. How well does behavioral analysis work on mobile (touch) vs desktop (mouse)?
3. Can we detect the specific signatures of browser-use, Playwright MCP, and Claude computer-use individually?
4. What is the false positive rate for users with motor disabilities, Parkinson's, or using assistive technology?
5. How do we handle the accessibility requirements (WCAG) for a maze-based CAPTCHA?
6. What is the optimal maze generation algorithm for maximizing behavioral signal while minimizing user frustration?
7. Can we use the Stroop effect or other cognitive interference tasks as an additional invisible signal layer within the maze (e.g., color-coded paths that create cognitive load)?

---

*Research compiled 2026-03-28. Sources cited inline throughout.*
