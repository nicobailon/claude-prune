# ccprune Summarization Quality Benchmark Plan

## Executive Summary

This document outlines a comprehensive plan to benchmark the summarization quality of different LLM backends supported by ccprune (Gemini 2.5 Flash, Gemini 3 Pro, Claude Haiku, Claude Sonnet). The benchmark will use state-of-the-art evaluation metrics, statistical rigor, and human validation to identify the best default model for ccprune.

**Timeline**: 5 weeks
**Budget**: $60-400
**Deliverables**: Benchmark scripts, test dataset, comprehensive report, model recommendation

---

## Table of Contents

1. [Background Research](#background-research)
2. [Current Implementation Analysis](#current-implementation-analysis)
3. [Benchmark Design](#benchmark-design)
4. [Evaluation Metrics](#evaluation-metrics)
5. [Implementation Plan](#implementation-plan)
6. [Success Criteria](#success-criteria)
7. [Budget & Resources](#budget--resources)
8. [References](#references)

---

## Background Research

### Key Findings from Literature

**Modern LLM-Based Metrics** (Recommended over traditional ROUGE/BLEU):

1. **G-Eval** (State-of-the-Art)
   - Uses GPT-4 to evaluate summaries across multiple dimensions
   - Reference-free (no ground truth needed)
   - Aligns closely with human judgment
   - Dimensions: Coherence, Consistency, Relevance, Fluency
   - Source: "G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment" (2023)

2. **QAG (Question-Answer Generation)**
   - Generates closed-ended questions from source
   - Checks if both source and summary answer consistently
   - Measures coverage and factual alignment objectively

3. **SummaC (Summary Consistency)**
   - Factual consistency between summary and source
   - Hallucination detection
   - Important for technical content

4. **BERTScore**
   - Semantic similarity using BERT embeddings
   - Token-level cosine similarity
   - Handles paraphrasing better than n-gram metrics

**Traditional Metrics** (Include for reference only):
- ROUGE-L: Recall-based n-gram overlap (pre-LLM era, limited value)
- BLEU: Precision-based n-gram matching (worse than ROUGE for summarization)

### Best Practices

1. **Multiple runs required**: LLM outputs are non-deterministic (run 3-5 iterations per test)
2. **Real data >> Synthetic**: Use actual Claude Code sessions, not artificial examples
3. **Human validation critical**: Automated metrics need ground truth calibration
4. **Statistical rigor**: Paired t-tests, effect sizes, confidence intervals
5. **Domain-specific metrics**: Add custom checks for code references, tool mentions
6. **Balance speed/cost/quality**: Consider all dimensions in final recommendation

---

## Current Implementation Analysis

### Summarization Backends

ccprune supports **two distinct summarization paths**:

#### Path A: Gemini API (Default when `GEMINI_API_KEY` is set)

**Location**: `src/index.ts:552-605` (`generateSummaryWithGemini()`)

**Models**:
- Gemini 2.5 Flash (`gemini-2.5-flash`) - Default, fast & cheap
- Gemini 3 Pro (`gemini-3-pro-preview`) - Higher quality, more expensive

**Characteristics**:
- Direct HTTPS POST to Google's Generative Language API
- No chunking needed (handles large context natively)
- Temperature: 0.7
- Max output: 8192 tokens
- Progress tracking via `setInterval`

**Auto-detection logic** (`src/index.ts:736-742`):
```typescript
if (!opts.claudeCode && !opts.gemini && !opts.geminiFlash) {
  if (process.env.GEMINI_API_KEY) {
    opts.gemini = true;
    opts.geminiFlash = true; // Default to Flash
  }
}
```

#### Path B: Claude Code CLI (Fallback or via `--claude-code`)

**Location**: `src/index.ts:607-725` (`generateSummary()`)

**Models**: User-configurable via `--summary-model`:
- `haiku` - Claude Haiku (fast, cheap)
- `sonnet` - Claude Sonnet (higher quality)
- Full model names supported

**Characteristics**:
- Spawns `claude -p` subprocess, pipes prompt via stdin
- **Chunking for large transcripts** (>30KB):
  - `MAX_SINGLE_PASS = 30000` (30KB)
  - `CHUNK_SIZE = 30000`
  - Process: Split → Summarize each chunk → Combine summaries
- Timeout: 360s default (configurable via `--summary-timeout`)
- Retry logic: Up to 2 retries on failure
- Progress tracking: 1-second interval callback

### Summary Format

**Required 5-section structure**:

1. **Overview** - Start with "Previously, we discussed..." and provide high-level summary
2. **What Was Accomplished** - Concrete outcomes, decisions, problems solved
3. **Files Modified or Examined** - List with brief descriptions
4. **Key Technical Details** - Patterns, conventions, architectural decisions
5. **Current State & Pending Work** - Incomplete tasks, planned next steps, blockers

**Format Guidelines**:
- Be comprehensive (replaces pruned conversation)
- Include specific file paths, function names, line numbers
- Code snippets only when essential for pattern understanding
- Note task evolution/progression

### Summary Synthesis Logic (Re-Pruning)

**Key Innovation**: When re-pruning a session that already has a summary, ccprune **synthesizes** old summary + new messages into one cohesive summary.

**Detection** (`src/index.ts:615-621`):
```typescript
const existingSummary = droppedMessages.find(m => m.isSummary);
const chatMessages = droppedMessages.filter(m => !m.isSummary);

// Edge case: only summary dropped (no chat) → return unchanged
if (existingSummary && chatMessages.length === 0) {
  return existingSummary.content;
}
```

**Synthesis Prompt** (`src/index.ts:650-667`):
```
You have an existing summary of earlier work, followed by a more recent
conversation that needs to be incorporated. Create a unified comprehensive summary.

## Instructions
1. Preserve critical context from existing summary that remains relevant
2. Integrate new accomplishments, decisions, file changes from recent conversation
3. Update "Current State & Pending Work" to reflect latest status
4. Remove outdated details that are no longer relevant
5. Maintain structured format with all sections

## Existing Summary:
[old summary content]

## Recent Conversation to Incorporate:
[new chat messages]
```

**Fallback for chunked summarization**:
- If transcript is large and requires chunking, existing summary is inserted as chunk 0
- All chunks (including old summary) are combined via `combineSummaries()`

### Existing Test Coverage

**Location**: `src/generateSummary.test.ts`

**Current tests**:
- 21 tests total (all passing)
- Tests for chunked summarization logic
- Tests for summary synthesis
- Mock subprocess spawning
- Edge cases: empty input, errors, timeouts

**Gaps**:
- No quality evaluation of generated summaries
- No comparison between backends
- No validation of structured format compliance
- No coverage/accuracy metrics

---

## Benchmark Design

### Overview

**5-phase benchmark** to evaluate summarization quality across all supported models with statistical rigor and human validation.

### Phase 1: Test Data Collection (Week 1)

**Goal**: Collect 30 real Claude Code session transcripts with diverse characteristics.

**Data Sources**:
1. ccprune development sessions (dogfooding)
2. Contributor sessions (anonymized)
3. Public Claude Code examples (if available)

**Categorization**:

| Dimension | Categories |
|-----------|-----------|
| **Type** | Bug fixes, Feature development, Code exploration, Refactoring, Mixed workflows |
| **Size** | Small (<20 msgs), Medium (20-50 msgs), Large (100+ msgs) |
| **Complexity** | File count, Tool usage frequency, Debugging iterations |

**Edge Cases to Include**:
- Agent/skill invocations (subagents)
- Error-heavy sessions (multiple failed attempts)
- Exploration-only (no files modified)
- Multi-day context (references previous work)
- **Re-prune scenarios** (sessions already containing a summary)

**Anonymization**:
- Remove sensitive paths (replace with generic `/path/to/project`)
- Strip API keys, credentials
- Redact company/user identifiable information
- Maintain technical content integrity

**Deliverable**: `benchmark/data/sessions/` directory with 30 `.jsonl` files

---

### Phase 2: Summary Generation (Week 2)

**Goal**: Generate summaries with all supported models under identical conditions.

**Models to Test**:
1. Gemini 2.5 Flash (API)
2. Gemini 3 Pro (API)
3. Claude Haiku (CLI)
4. Claude Sonnet (CLI)

**Test Parameters**:
- **Repetitions**: 3 runs per session × model (handle non-determinism)
- **Total summaries**: 30 sessions × 4 models × 3 reps = **360 summaries**
- **Temperature**: Use default for each model (document in metadata)
- **Format**: Enforce identical 5-section structure for all

**Metadata to Log**:
```json
{
  "session_id": "uuid",
  "model": "gemini-2.5-flash",
  "run": 1,
  "timestamp": "2025-11-29T...",
  "latency_ms": 3421,
  "input_tokens": 12453,
  "output_tokens": 1834,
  "cost_usd": 0.023,
  "error": null
}
```

**Implementation**:
```python
# benchmark/scripts/generate.py
for session in sessions:
    for model in models:
        for run in range(3):
            summary, metadata = generate_summary(session, model)
            save_summary(f"summaries/{model}/{session.id}_{run}.json",
                        summary, metadata)
```

**Deliverable**: `benchmark/data/summaries/{model}/` directories with 90 summaries each

---

### Phase 3: Automated Evaluation (Week 3)

**Goal**: Run state-of-the-art automated metrics on all summaries.

**Metrics Suite**:

| Metric | Purpose | Tool |
|--------|---------|------|
| **G-Eval** | Multi-dimensional quality (primary) | deepeval |
| **BERTScore** | Semantic similarity | bert-score |
| **QAG Score** | Coverage & factual alignment | deepeval |
| **SummaC** | Hallucination/consistency check | summac |
| **ROUGE-L** | Industry baseline (reference only) | rouge-score |

**Setup**:
```bash
pip install deepeval bert-score summac rouge-score scipy pandas
pip install google-generativeai anthropic  # For G-Eval
```

**G-Eval Configuration** (Primary Metric):
```python
from deepeval.metrics import GEval

g_eval = GEval(
    name="Technical Summary Quality",
    criteria="Coherence, Consistency, Relevance, Fluency, Technical Accuracy",
    evaluation_params=["input", "actual_output"],
    model="gpt-4o"  # or "claude-3-5-sonnet-20241022"
)

score = g_eval.measure(
    input=session_transcript,
    actual_output=summary
)
```

**BERTScore Usage**:
```python
from bert_score import score

P, R, F1 = score([summary], [session_transcript],
                 lang="en", verbose=True)
```

**Custom Metrics** (ccprune-specific):

1. **Code Reference Preservation Rate**:
   ```python
   # Extract file paths from original transcript
   original_paths = extract_file_paths(transcript)
   summary_paths = extract_file_paths(summary)

   preservation_rate = len(summary_paths & original_paths) / len(original_paths)
   ```

2. **Structured Format Compliance**:
   ```python
   # Check for 5 required sections
   has_overview = "## 1. Overview" in summary
   has_accomplished = "## 2. What Was Accomplished" in summary
   has_files = "## 3. Files Modified" in summary
   has_technical = "## 4. Key Technical Details" in summary
   has_current_state = "## 5. Current State" in summary

   compliance_score = sum([has_overview, has_accomplished,
                          has_files, has_technical, has_current_state]) / 5
   ```

3. **Tool Mention Accuracy**:
   ```python
   # Extract tool usage from transcript (Read, Edit, Bash, etc.)
   original_tools = extract_tool_names(transcript)
   summary_tools = extract_tool_names(summary)

   precision = len(summary_tools & original_tools) / len(summary_tools)
   recall = len(summary_tools & original_tools) / len(original_tools)
   tool_f1 = 2 * precision * recall / (precision + recall)
   ```

**Output Format**:
```csv
session_id,model,run,bertscore_f1,g_eval_coherence,g_eval_consistency,g_eval_relevance,g_eval_fluency,qag_score,summac_score,rouge_l,code_preservation,format_compliance,tool_f1
uuid1,gemini-2.5-flash,0,0.87,4.2,4.5,4.3,4.6,0.82,0.91,0.45,0.89,1.0,0.76
...
```

**Deliverable**: `benchmark/results/metrics.csv` with all automated scores

---

### Phase 4: Human Validation (Week 4)

**Goal**: Validate automated metrics align with human judgment on summary quality.

**Sample Selection**:
- **10 sessions** stratified by type and size
- **3 raters** (developers familiar with Claude Code)
- **4 models** × 1 run per session = **40 summaries** to rate

**Blind Evaluation Protocol**:
1. Randomize summary order (no model labels)
2. Show original transcript context (first 500 chars for orientation)
3. Present summaries one at a time
4. Rate on 1-5 Likert scale (1=Poor, 5=Excellent):
   - **Clarity**: Is the summary understandable?
   - **Accuracy**: Does it capture what actually happened?
   - **Coverage**: Are key technical details included?
   - **Usefulness**: Would this help you resume work?
   - **Overall**: Overall quality rating
5. Optional written feedback field

**CLI Interface** (example):
```python
# benchmark/scripts/evaluate_human.py
import typer

def human_evaluation_cli(rater_name: str):
    sessions = load_sessions_for_human_eval()
    ratings = []

    for session in sessions:
        print(f"\nSession Context:\n{session['text'][:500]}...\n")

        summaries = shuffle_summaries(session['summaries'])

        for idx, (summary_id, summary_text) in enumerate(summaries, 1):
            print(f"Summary {idx}:\n{summary_text}\n")

            rating = {
                'session_id': session['id'],
                'summary_id': summary_id,
                'rater': rater_name,
                'clarity': typer.prompt("Clarity (1-5)", type=int),
                'accuracy': typer.prompt("Accuracy (1-5)", type=int),
                'coverage': typer.prompt("Coverage (1-5)", type=int),
                'usefulness': typer.prompt("Usefulness (1-5)", type=int),
                'overall': typer.prompt("Overall (1-5)", type=int),
                'notes': typer.prompt("Notes (optional)", default="")
            }
            ratings.append(rating)

    save_ratings(ratings, f'results/human_{rater_name}.json')
```

**Inter-Rater Reliability**:
- Calculate Krippendorff's alpha (α > 0.67 = acceptable)
- If α < 0.67, add more raters or refine rating criteria

**Correlation Analysis**:
```python
import scipy.stats as stats

# Merge automated metrics with human ratings
merged = merge_auto_human(auto_df, human_df)

# Calculate correlations
for metric in ['bertscore_f1', 'g_eval_overall', 'qag_score']:
    corr, p_value = stats.pearsonr(merged[metric], merged['human_overall'])
    print(f"{metric} ↔ human_overall: r={corr:.3f}, p={p_value:.4f}")
```

**Success Threshold**: Pearson r > 0.7 for G-Eval correlation with human ratings

**Deliverable**: `benchmark/results/human_ratings.csv` and correlation report

---

### Phase 5: Analysis & Reporting (Week 5)

**Goal**: Statistical comparison of models and final recommendation.

#### Statistical Tests

**Paired t-tests** (or Wilcoxon signed-rank if non-normal):
```python
import scipy.stats as stats

for metric in ['g_eval_overall', 'bertscore_f1', 'human_overall']:
    print(f"\n{metric.upper()}:")

    # Compare each pair of models
    for i, model1 in enumerate(models):
        for model2 in models[i+1:]:
            scores1 = df[df['model'] == model1][metric]
            scores2 = df[df['model'] == model2][metric]

            # Check normality
            _, p_normal = stats.shapiro(scores1 - scores2)

            if p_normal > 0.05:
                # Paired t-test
                t_stat, p_value = stats.ttest_rel(scores1, scores2)
                test_name = "t-test"
            else:
                # Wilcoxon signed-rank test
                t_stat, p_value = stats.wilcoxon(scores1, scores2)
                test_name = "Wilcoxon"

            # Effect size (Cohen's d)
            pooled_std = np.sqrt((scores1.std()**2 + scores2.std()**2) / 2)
            cohens_d = (scores1.mean() - scores2.mean()) / pooled_std

            sig = "***" if p_value < 0.001 else "**" if p_value < 0.01 else "*" if p_value < 0.05 else ""

            print(f"  {model1} vs {model2}: ")
            print(f"    {test_name}: p={p_value:.4f} {sig}")
            print(f"    Effect size: d={cohens_d:.3f}")
```

**Confidence Intervals** (95%):
```python
from scipy.stats import t as t_dist

for model in models:
    scores = df[df['model'] == model]['g_eval_overall']
    mean = scores.mean()
    sem = scores.sem()
    ci = t_dist.interval(0.95, len(scores)-1, loc=mean, scale=sem)

    print(f"{model}: {mean:.3f} [95% CI: {ci[0]:.3f}, {ci[1]:.3f}]")
```

#### Weighted Scoring

**Formula**:
```python
def calculate_final_score(row):
    quality = (row['g_eval_overall'] + row['bertscore_f1'] * 5 +
               row['qag_score'] * 5 + row['summac_score'] * 5) / 4

    # Normalize latency (lower is better)
    norm_speed = 1 - (row['latency_ms'] / df['latency_ms'].max())

    # Normalize cost (lower is better)
    norm_cost = 1 - (row['cost_usd'] / df['cost_usd'].max())

    reliability = 1 - row['error_rate']

    final_score = (
        0.40 * quality +
        0.30 * row['human_overall'] / 5 +  # Normalize to 0-1
        0.15 * norm_speed +
        0.10 * norm_cost +
        0.05 * reliability
    )

    return final_score
```

**Sensitivity Analysis**:
- Test different weight combinations
- Report how robust the ranking is to weight changes

#### Report Structure

**Benchmark Report** (`benchmark/results/report.md`):

1. **Executive Summary**
   - Winner by weighted score
   - Key findings
   - Recommendation

2. **Methodology**
   - Test data characteristics
   - Evaluation metrics used
   - Statistical approach

3. **Results**
   - **Table 1**: Automated metrics by model (mean ± std)
   - **Table 2**: Human ratings by model
   - **Table 3**: Performance metrics (latency, cost)
   - **Table 4**: Statistical significance matrix
   - **Table 5**: Final weighted scores

4. **Analysis**
   - Best-in-class for each dimension
   - Cost-benefit tradeoffs
   - When to use each model

5. **Recommendations**
   - Default model for ccprune
   - High-quality alternative
   - Budget-conscious option

6. **Limitations & Future Work**
   - Sample size considerations
   - Metric limitations
   - Areas for improvement

**Deliverable**: Complete benchmark report with visualizations

---

## Evaluation Metrics

### Metric Definitions

#### G-Eval (Primary)

**What it measures**: Multi-dimensional summary quality using LLM-as-judge

**Dimensions**:
1. **Coherence**: Logical flow and organization
2. **Consistency**: Factual alignment with source
3. **Relevance**: Includes important information
4. **Fluency**: Grammatical correctness and readability

**Scoring**: 1-5 scale for each dimension

**Implementation**:
```python
from deepeval.metrics import GEval

g_eval = GEval(
    name="Summary Quality",
    criteria="Coherence, Consistency, Relevance, Fluency",
    evaluation_params=["input", "actual_output"],
    model="gpt-4o"
)

result = g_eval.measure(input=transcript, actual_output=summary)
```

**Pros**:
- State-of-the-art correlation with human judgment
- Reference-free (no ground truth needed)
- Captures nuanced quality dimensions

**Cons**:
- Requires API costs (~$0.03 per summary)
- Non-deterministic (use temperature=0 for consistency)

#### BERTScore

**What it measures**: Semantic similarity using BERT embeddings

**Formula**: Token-level cosine similarity between summary and source

**Scoring**: Precision, Recall, F1 (0-1 scale)

**Implementation**:
```python
from bert_score import score

P, R, F1 = score([summary], [transcript],
                 lang="en", model_type="microsoft/deberta-xlarge-mnli")
```

**Pros**:
- Handles paraphrasing
- Fast, local computation
- Widely used baseline

**Cons**:
- Doesn't capture all quality dimensions
- Requires reference (we use original transcript)

#### QAG Score

**What it measures**: Coverage and factual alignment

**Method**:
1. Generate closed-ended questions from source
2. Answer questions using source
3. Answer same questions using summary
4. Compare answer consistency

**Scoring**: Consistency rate (0-1 scale)

**Implementation**:
```python
from deepeval.metrics import QAGScore

qag = QAGScore()
score = qag.measure(input=transcript, actual_output=summary)
```

**Pros**:
- Objective measure of coverage
- Reduces evaluation bias
- Good for factual content

**Cons**:
- Requires question generation (LLM cost)
- May miss subjective quality aspects

#### SummaC

**What it measures**: Factual consistency (hallucination detection)

**Method**: Uses NLI model to check if summary is entailed by source

**Scoring**: Consistency score (0-1 scale)

**Implementation**:
```python
from summac.model_summac import SummaCZS

model = SummaCZS(granularity="sentence", model_name="vitc")
score = model.score([transcript], [summary])['score']
```

**Pros**:
- Specifically targets hallucinations
- Important for technical content
- Fast, local model

**Cons**:
- Only measures consistency, not other quality dimensions

#### Custom Metrics

**Code Reference Preservation**:
```python
import re

def extract_file_paths(text):
    # Pattern: src/index.ts:123 or src/file.ts
    pattern = r'\b[\w/]+\.(ts|js|py|md|json)(?::\d+)?\b'
    return set(re.findall(pattern, text))

def code_preservation_rate(transcript, summary):
    original = extract_file_paths(transcript)
    preserved = extract_file_paths(summary)

    if len(original) == 0:
        return 1.0  # No files to preserve

    return len(preserved & original) / len(original)
```

**Structured Format Compliance**:
```python
def check_format_compliance(summary):
    required_sections = [
        "## 1. Overview",
        "## 2. What Was Accomplished",
        "## 3. Files Modified",
        "## 4. Key Technical Details",
        "## 5. Current State"
    ]

    score = sum(section in summary for section in required_sections) / len(required_sections)
    return score
```

### Metric Weights

**Automated Quality Score** (for final ranking):
```python
automated_quality = (
    g_eval_overall * 0.50 +      # Primary metric
    bertscore_f1 * 5 * 0.20 +    # Normalize to 0-5 scale
    qag_score * 5 * 0.15 +       # Coverage
    summac_score * 5 * 0.10 +    # Consistency
    code_preservation * 5 * 0.05 # Domain-specific
)
```

---

## Implementation Plan

### File Structure

```
/benchmark
  /data
    /sessions
      bug-fix-001.jsonl
      feature-002.jsonl
      ...
    /summaries
      /gemini-2.5-flash
        bug-fix-001_0.json
        bug-fix-001_1.json
        bug-fix-001_2.json
        ...
      /gemini-3-pro
      /claude-haiku
      /claude-sonnet
    /human_ratings
      rater1.csv
      rater2.csv
      rater3.csv
  /scripts
    collect_sessions.py      # Gather & anonymize sessions
    generate.py              # Generate summaries (all models)
    evaluate_auto.py         # Run automated metrics
    evaluate_human.py        # CLI for human raters
    analyze.py               # Statistical analysis
    report.py                # Generate markdown report
    utils.py                 # Shared utilities
  /results
    metadata.csv             # Generation metadata
    metrics.csv              # Automated scores
    human_ratings.csv        # Human eval data
    analysis.json            # Statistical test results
    report.md                # Final benchmark report
  benchmark.config.json      # Test configuration
  requirements.txt           # Python dependencies
  README.md                  # Benchmark documentation
```

### Configuration File

**`benchmark.config.json`**:
```json
{
  "models": [
    {
      "name": "gemini-2.5-flash",
      "type": "gemini",
      "api_key_env": "GEMINI_API_KEY",
      "temperature": 0.7,
      "max_output_tokens": 8192
    },
    {
      "name": "gemini-3-pro",
      "type": "gemini",
      "api_key_env": "GEMINI_API_KEY",
      "temperature": 0.7,
      "max_output_tokens": 8192
    },
    {
      "name": "claude-haiku",
      "type": "claude-cli",
      "model_flag": "haiku",
      "timeout_ms": 360000
    },
    {
      "name": "claude-sonnet",
      "type": "claude-cli",
      "model_flag": "sonnet",
      "timeout_ms": 360000
    }
  ],
  "test_data": {
    "session_dir": "./data/sessions",
    "target_count": 30,
    "repetitions": 3,
    "categories": {
      "bug_fix": 8,
      "feature_dev": 8,
      "exploration": 6,
      "refactoring": 5,
      "mixed": 3
    }
  },
  "metrics": {
    "automated": [
      "g-eval",
      "bertscore",
      "qag",
      "summac",
      "rouge-l",
      "code-preservation",
      "format-compliance"
    ],
    "human": [
      "clarity",
      "accuracy",
      "coverage",
      "usefulness",
      "overall"
    ]
  },
  "g_eval": {
    "model": "gpt-4o",
    "dimensions": ["coherence", "consistency", "relevance", "fluency"],
    "temperature": 0
  },
  "human_eval": {
    "sample_size": 10,
    "raters": 3,
    "randomize_order": true
  },
  "weights": {
    "automated_quality": 0.40,
    "human_rating": 0.30,
    "speed": 0.15,
    "cost": 0.10,
    "reliability": 0.05
  }
}
```

### Script Implementations

#### 1. Session Collection (`collect_sessions.py`)

```python
#!/usr/bin/env python3
import os
import json
import re
from pathlib import Path
from typing import List, Dict

def anonymize_session(session_path: str) -> Dict:
    """Load and anonymize a session file."""
    with open(session_path, 'r') as f:
        lines = f.readlines()

    anonymized = []
    for line in lines:
        try:
            obj = json.loads(line)

            # Anonymize paths
            if 'cwd' in obj:
                obj['cwd'] = '/path/to/project'

            # Anonymize content
            if 'message' in obj and 'content' in obj['message']:
                content = obj['message']['content']
                if isinstance(content, str):
                    # Replace user paths
                    content = re.sub(r'/Users/\w+/', '/Users/user/', content)
                    content = re.sub(r'/home/\w+/', '/home/user/', content)
                    obj['message']['content'] = content

            anonymized.append(json.dumps(obj))
        except json.JSONDecodeError:
            continue

    return '\n'.join(anonymized)

def collect_sessions(source_dir: str, output_dir: str, target_count: int):
    """Collect and categorize sessions."""
    os.makedirs(output_dir, exist_ok=True)

    sessions = []
    for session_file in Path(source_dir).glob('*.jsonl'):
        anonymized = anonymize_session(str(session_file))

        # Analyze session characteristics
        category = categorize_session(anonymized)
        size = count_messages(anonymized)

        sessions.append({
            'original': str(session_file),
            'content': anonymized,
            'category': category,
            'size': size
        })

    # Sample stratified by category
    selected = stratified_sample(sessions, target_count)

    # Save to output
    for i, session in enumerate(selected):
        output_path = f"{output_dir}/{session['category']}-{i:03d}.jsonl"
        with open(output_path, 'w') as f:
            f.write(session['content'])

    print(f"Collected {len(selected)} sessions to {output_dir}")

if __name__ == '__main__':
    collect_sessions(
        source_dir='~/.claude/projects/-Users-user-Documents-development-claude-prune',
        output_dir='./data/sessions',
        target_count=30
    )
```

#### 2. Summary Generation (`generate.py`)

```python
#!/usr/bin/env python3
import json
import time
import subprocess
from pathlib import Path
from typing import Dict, List
import google.generativeai as genai

def load_config(config_path: str = 'benchmark.config.json') -> Dict:
    with open(config_path, 'r') as f:
        return json.load(f)

def load_session(session_path: str) -> str:
    """Load session transcript."""
    with open(session_path, 'r') as f:
        lines = f.readlines()

    transcript = []
    for line in lines:
        try:
            obj = json.loads(line)
            if obj.get('type') in ['user', 'assistant']:
                role = obj['type'].capitalize()
                content = extract_content(obj['message']['content'])
                transcript.append(f"{role}: {content}")
        except:
            continue

    return '\n\n'.join(transcript)

def generate_with_gemini(session_text: str, model: Dict) -> tuple[str, Dict]:
    """Generate summary using Gemini API."""
    genai.configure(api_key=os.getenv(model['api_key_env']))

    model_obj = genai.GenerativeModel(model['name'])

    prompt = build_summary_prompt(session_text)

    start = time.time()
    response = model_obj.generate_content(
        prompt,
        generation_config={
            'temperature': model['temperature'],
            'max_output_tokens': model['max_output_tokens']
        }
    )
    latency = (time.time() - start) * 1000

    metadata = {
        'latency_ms': latency,
        'input_tokens': response.usage_metadata.prompt_token_count,
        'output_tokens': response.usage_metadata.candidates_token_count,
        'cost_usd': estimate_cost(model['name'], response.usage_metadata)
    }

    return response.text, metadata

def generate_with_claude_cli(session_text: str, model: Dict) -> tuple[str, Dict]:
    """Generate summary using Claude CLI."""
    prompt = build_summary_prompt(session_text)

    cmd = ['claude', '-p', '--model', model['model_flag']]

    start = time.time()
    result = subprocess.run(
        cmd,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=model['timeout_ms'] / 1000
    )
    latency = (time.time() - start) * 1000

    if result.returncode != 0:
        raise RuntimeError(f"Claude CLI failed: {result.stderr}")

    summary = result.stdout.strip()

    metadata = {
        'latency_ms': latency,
        'input_tokens': len(prompt.split()),  # Rough estimate
        'output_tokens': len(summary.split()),
        'cost_usd': 0  # Free via CLI
    }

    return summary, metadata

def run_benchmark(config: Dict):
    """Run full benchmark generation."""
    sessions = list(Path(config['test_data']['session_dir']).glob('*.jsonl'))

    for session_path in sessions:
        session_id = session_path.stem
        session_text = load_session(str(session_path))

        for model in config['models']:
            model_name = model['name']

            for run in range(config['test_data']['repetitions']):
                print(f"Generating: {session_id} | {model_name} | run {run}")

                try:
                    if model['type'] == 'gemini':
                        summary, metadata = generate_with_gemini(session_text, model)
                    elif model['type'] == 'claude-cli':
                        summary, metadata = generate_with_claude_cli(session_text, model)

                    # Save summary
                    output_dir = f"data/summaries/{model_name}"
                    os.makedirs(output_dir, exist_ok=True)

                    output = {
                        'session_id': session_id,
                        'model': model_name,
                        'run': run,
                        'summary': summary,
                        'metadata': metadata
                    }

                    output_path = f"{output_dir}/{session_id}_{run}.json"
                    with open(output_path, 'w') as f:
                        json.dump(output, f, indent=2)

                except Exception as e:
                    print(f"  ERROR: {e}")
                    continue

if __name__ == '__main__':
    config = load_config()
    run_benchmark(config)
```

#### 3. Automated Evaluation (`evaluate_auto.py`)

```python
#!/usr/bin/env python3
import json
import pandas as pd
from pathlib import Path
from deepeval.metrics import GEval, QAGScore
from bert_score import score as bertscore
from summac.model_summac import SummaCZS

def load_config():
    with open('benchmark.config.json', 'r') as f:
        return json.load(f)

def evaluate_all_summaries(config: Dict):
    """Run all automated metrics on generated summaries."""

    # Initialize metrics
    g_eval = GEval(
        name="Summary Quality",
        criteria="Coherence, Consistency, Relevance, Fluency",
        evaluation_params=["input", "actual_output"],
        model=config['g_eval']['model']
    )

    qag = QAGScore()
    summac_model = SummaCZS(granularity="sentence", model_name="vitc")

    results = []

    # Load sessions
    sessions = {}
    for session_file in Path(config['test_data']['session_dir']).glob('*.jsonl'):
        session_id = session_file.stem
        sessions[session_id] = load_session(str(session_file))

    # Evaluate each summary
    summary_files = Path('data/summaries').rglob('*.json')

    for summary_file in summary_files:
        with open(summary_file, 'r') as f:
            data = json.load(f)

        session_id = data['session_id']
        model = data['model']
        run = data['run']
        summary = data['summary']
        transcript = sessions[session_id]

        print(f"Evaluating: {session_id} | {model} | run {run}")

        # G-Eval
        g_eval_result = g_eval.measure(input=transcript, actual_output=summary)

        # BERTScore
        P, R, F1 = bertscore([summary], [transcript], lang="en")

        # QAG
        qag_score = qag.measure(input=transcript, actual_output=summary)

        # SummaC
        summac_score = summac_model.score([transcript], [summary])['score']

        # Custom metrics
        code_pres = code_preservation_rate(transcript, summary)
        format_comp = check_format_compliance(summary)

        results.append({
            'session_id': session_id,
            'model': model,
            'run': run,
            'bertscore_f1': F1.mean().item(),
            'g_eval_coherence': g_eval_result['coherence'],
            'g_eval_consistency': g_eval_result['consistency'],
            'g_eval_relevance': g_eval_result['relevance'],
            'g_eval_fluency': g_eval_result['fluency'],
            'g_eval_overall': g_eval_result['overall'],
            'qag_score': qag_score,
            'summac_score': summac_score,
            'code_preservation': code_pres,
            'format_compliance': format_comp,
            **data['metadata']  # Include latency, cost, etc.
        })

    # Save results
    df = pd.DataFrame(results)
    df.to_csv('results/metrics.csv', index=False)

    print(f"\n✓ Evaluated {len(results)} summaries")
    print(f"✓ Saved to results/metrics.csv")

if __name__ == '__main__':
    config = load_config()
    evaluate_all_summaries(config)
```

#### 4. Analysis Script (`analyze.py`)

```python
#!/usr/bin/env python3
import pandas as pd
import numpy as np
import scipy.stats as stats
import matplotlib.pyplot as plt

def analyze_benchmark():
    """Perform statistical analysis on benchmark results."""

    # Load data
    auto_df = pd.read_csv('results/metrics.csv')

    # Group by model (average across runs)
    model_stats = auto_df.groupby('model').agg({
        'g_eval_overall': ['mean', 'std', 'count'],
        'bertscore_f1': ['mean', 'std'],
        'qag_score': ['mean', 'std'],
        'summac_score': ['mean', 'std'],
        'latency_ms': ['mean', 'std'],
        'cost_usd': ['sum', 'mean']
    }).round(3)

    print("=== Model Performance Summary ===\n")
    print(model_stats)

    # Statistical significance tests
    models = auto_df['model'].unique()

    print("\n=== Pairwise Statistical Tests (G-Eval Overall) ===\n")

    for i, m1 in enumerate(models):
        for m2 in models[i+1:]:
            scores1 = auto_df[auto_df['model'] == m1]['g_eval_overall']
            scores2 = auto_df[auto_df['model'] == m2]['g_eval_overall']

            # Paired t-test
            t_stat, p_value = stats.ttest_ind(scores1, scores2)

            # Effect size (Cohen's d)
            pooled_std = np.sqrt((scores1.std()**2 + scores2.std()**2) / 2)
            cohens_d = (scores1.mean() - scores2.mean()) / pooled_std

            sig = "***" if p_value < 0.001 else "**" if p_value < 0.01 else "*" if p_value < 0.05 else "ns"

            print(f"{m1} vs {m2}:")
            print(f"  Δ = {scores1.mean() - scores2.mean():+.3f}")
            print(f"  t = {t_stat:.3f}, p = {p_value:.4f} {sig}")
            print(f"  Cohen's d = {cohens_d:.3f}\n")

    # Weighted scoring
    print("=== Final Weighted Scores ===\n")

    def calculate_final_score(group):
        quality = (group['g_eval_overall'].mean() +
                   group['bertscore_f1'].mean() * 5 +
                   group['qag_score'].mean() * 5 +
                   group['summac_score'].mean() * 5) / 4

        # Normalize (inverse for latency/cost)
        max_latency = auto_df['latency_ms'].max()
        max_cost = auto_df['cost_usd'].max()

        norm_speed = 1 - (group['latency_ms'].mean() / max_latency)
        norm_cost = 1 - (group['cost_usd'].mean() / max_cost) if max_cost > 0 else 1

        reliability = 1 - (group['error_rate'].mean() if 'error_rate' in group else 0)

        final = (
            0.40 * quality +
            0.30 * quality +  # Placeholder (use human ratings when available)
            0.15 * norm_speed +
            0.10 * norm_cost +
            0.05 * reliability
        )

        return pd.Series({
            'quality_score': quality,
            'speed_score': norm_speed,
            'cost_score': norm_cost,
            'final_score': final
        })

    final_scores = auto_df.groupby('model').apply(calculate_final_score).round(3)
    final_scores = final_scores.sort_values('final_score', ascending=False)

    print(final_scores)

    # Winner
    winner = final_scores.index[0]
    print(f"\n🏆 Winner: {winner} (score: {final_scores.loc[winner, 'final_score']:.3f})")

if __name__ == '__main__':
    analyze_benchmark()
```

---

## Success Criteria

### Benchmark Validity

✅ **Metric Validation**:
- G-Eval correlates with human ratings (Pearson r > 0.7)
- Inter-rater reliability acceptable (Krippendorff's α > 0.67)
- Automated metrics show consistent rankings across sessions

✅ **Statistical Rigor**:
- Sample size adequate (n ≥ 30 sessions)
- Significant differences detected (p < 0.05 for top 2 models)
- Effect sizes reported (Cohen's d)
- 95% confidence intervals calculated

✅ **Reproducibility**:
- All scripts documented and runnable
- Configuration file captures all parameters
- Random seeds set for deterministic results
- Raw data and results version controlled

### Decision Quality

✅ **Clear Recommendation**:
- Weighted scoring identifies winner
- Cost-benefit analysis completed
- Use cases for each model documented
- Sensitivity analysis shows robust ranking

✅ **Actionable Insights**:
- Default model selected for ccprune
- High-quality alternative identified
- Budget-conscious option documented
- Edge cases flagged (when default fails)

---

## Budget & Resources

### Cost Breakdown

**Summary Generation** (360 summaries total):
- Gemini 2.5 Flash: 90 summaries × $0.02 = $1.80
- Gemini 3 Pro: 90 summaries × $0.10 = $9.00
- Claude Haiku (CLI): Free
- Claude Sonnet (CLI): Free
- **Subtotal**: ~$11

**Automated Evaluation**:
- G-Eval (GPT-4): 360 summaries × $0.03 = $10.80
- BERTScore: Free (local)
- QAG: 360 summaries × $0.02 = $7.20
- SummaC: Free (local)
- **Subtotal**: ~$18

**Human Evaluation**:
- Option A: 3 raters × 2 hours × $50/hr = $300
- Option B: Volunteer contributors = $0
- **Subtotal**: $0-300

**Total Budget**: **$30-330**

### Time Estimate

| Phase | Duration | Effort |
|-------|----------|--------|
| Test Data Collection | Week 1 | 8 hours |
| Summary Generation | Week 2 | 4 hours (mostly automated) |
| Automated Evaluation | Week 3 | 6 hours |
| Human Validation | Week 4 | 6-8 hours (rater time) |
| Analysis & Reporting | Week 5 | 10 hours |
| **Total** | **5 weeks** | **34-36 hours** |

### Dependencies

**Software**:
```bash
# Python environment
python >= 3.9

# Core libraries
pip install deepeval bert-score summac rouge-score
pip install scipy pandas numpy matplotlib seaborn
pip install google-generativeai anthropic

# Optional (for report generation)
pip install jinja2 markdown
```

**Environment Variables**:
```bash
export GEMINI_API_KEY="your-key-here"
export OPENAI_API_KEY="your-key-here"  # For G-Eval
```

**System Requirements**:
- Claude Code CLI installed (`claude --version`)
- 10GB disk space (for summaries and results)
- 8GB RAM (for BERTScore/SummaC models)

---

## References

### Academic Papers

1. **G-Eval**: Liu et al. (2023), "G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment"
2. **SummEval**: Fabbri et al. (2021), "SummEval: Re-evaluating Summarization Evaluation" (TACL)
3. **BERTScore**: Zhang et al. (2020), "BERTScore: Evaluating Text Generation with BERT" (ICLR)
4. **SummaC**: Laban et al. (2022), "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization" (TACL)
5. **FineSurE**: Shen et al. (2024), "Fine-grained Summarization Evaluation using Large Language Models"

### Tools & Libraries

- **DeepEval**: https://docs.confident-ai.com/docs/metrics-summarization
- **BERTScore**: https://github.com/Tiiiger/BERTScore
- **SummaC**: https://github.com/tingofurro/summac
- **ROUGE**: https://github.com/google-research/google-research/tree/master/rouge

### Industry Resources

- **OpenAI Cookbook** (Summarization Eval): https://cookbook.openai.com/examples/evaluation/how_to_eval_abstractive_summarization
- **Microsoft G-Eval Guide**: https://learn.microsoft.com/en-us/ai/playbook/technology-guidance/generative-ai/working-with-llms/evaluation/g-eval-metric-for-summarization
- **AWS FMEval**: https://aws.amazon.com/blogs/machine-learning/evaluate-the-text-summarization-capabilities-of-llms

### Benchmark Datasets

- **InstruSum**: https://github.com/amazon-science/instruct-to-summ
- **SAMSum**: https://huggingface.co/datasets/samsum (conversational summarization)
- **UserSumBench**: User summarization benchmark (2024)

---

## Appendices

### A. Prompt Templates

**Fresh Summary Prompt** (from `src/index.ts`):
```
Here is a unified comprehensive summary of our coding conversation:

## 1. Overview
Previously, we discussed... [high-level summary]

## 2. What Was Accomplished
[Concrete outcomes, decisions, problems solved]

## 3. Files Modified or Examined
[List with brief descriptions]

## 4. Key Technical Details
[Patterns, conventions, architectural decisions]

## 5. Current State & Pending Work
[Incomplete tasks, planned next steps, blockers]
```

**Synthesis Prompt** (re-pruning):
```
You have an existing summary of earlier work, followed by a more recent
conversation that needs to be incorporated. Create a unified comprehensive summary.

## Instructions
1. Preserve critical context from existing summary that remains relevant
2. Integrate new accomplishments, decisions, file changes from recent conversation
3. Update "Current State & Pending Work" to reflect latest status
4. Remove outdated details no longer relevant
5. Maintain structured format with all sections

## Existing Summary:
[old summary]

## Recent Conversation to Incorporate:
[new messages]
```

### B. Sample Analysis Output

```
=== Model Performance Summary ===

                    g_eval_overall          bertscore_f1         latency_ms
                    mean   std  count       mean   std           mean    std
model
gemini-2.5-flash    4.21  0.18   90        0.847  0.032        3421    512
gemini-3-pro        4.58  0.14   90        0.891  0.028        8932   1243
claude-haiku        4.05  0.21   90        0.823  0.041        2145    387
claude-sonnet       4.51  0.16   90        0.882  0.031        7821   1121

=== Pairwise Statistical Tests ===

gemini-2.5-flash vs gemini-3-pro:
  Δ = -0.370
  t = -14.523, p = 0.0000 ***
  Cohen's d = -2.163

gemini-2.5-flash vs claude-sonnet:
  Δ = -0.300
  t = -11.234, p = 0.0000 ***
  Cohen's d = -1.674

gemini-3-pro vs claude-sonnet:
  Δ = +0.070
  t = 2.981, p = 0.0034 **
  Cohen's d = 0.444

=== Final Weighted Scores ===

                  quality  speed  cost  final_score
gemini-2.5-flash   4.15   0.82  0.95      0.742
gemini-3-pro       4.52   0.34  0.71      0.698
claude-haiku       3.98   0.92  1.00      0.721
claude-sonnet      4.48   0.41  1.00      0.735

🏆 Winner: gemini-2.5-flash (score: 0.742)
```

### C. Human Evaluation Form Example

```
Session ID: bug-fix-001
Context: "User debugging token estimation bug in ccprune..."

Summary 1:
[summary text - model hidden]

Rate this summary (1-5):
Clarity: ___
Accuracy: ___
Coverage: ___
Usefulness: ___
Overall: ___

Notes (optional): ___________________________________

[Repeat for Summaries 2, 3, 4]
```

---

## Document History

- **Version 1.0** (2025-11-29): Initial benchmark plan
- **Authors**: Research conducted via web search + codebase analysis
- **Status**: Draft for review

---

**END OF DOCUMENT**
