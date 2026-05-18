import { AzureOpenAI } from "openai";
import { logger } from "../utils/logger";

interface AiResult {
  explanation: string;
  impact: string;
  fix_code: string;
}

class AiService {
  private client?: AzureOpenAI;

  private azureOpenai(): AzureOpenAI | null {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!endpoint || !apiKey || !deployment) {
      return null;
    }

    if (!this.client) {
      this.client = new AzureOpenAI({
        endpoint,
        apiKey,
        apiVersion,
        deployment
      });
    }

    return this.client;
  }

  private deploymentName(): string {
    return process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";
  }

  async explainIssue(issue: any): Promise<AiResult> {
    const prompt = `You are an expert accessibility engineer. Analyze this WCAG accessibility issue and provide:
1. A clear explanation of WHY this issue matters (2-3 sentences, plain English)
2. The USER IMPACT — who is affected and how (mention specific disability groups)
3. A concrete CODE FIX with before/after HTML/CSS/JS examples

Issue details:
- Rule: ${issue.rule_id}
- Severity: ${issue.severity}
- Message: ${issue.message}
- WCAG Criteria: ${(issue.wcag_criteria || []).join(", ")}
- Selector: ${issue.selector || "N/A"}
- HTML snippet: ${issue.html_snippet || "N/A"}
- Category: ${issue.category || "N/A"}

Respond in JSON format:
{
  "explanation": "...",
  "impact": "...",
  "fix_code": "// Before:\\n...\\n\\n// After:\\n..."
}`;

    try {
      const openai = this.azureOpenai();
      if (!openai) {
        throw new Error("Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT.");
      }

      const response = await openai.chat.completions.create({
        model: this.deploymentName(),
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 1000,
        temperature: 0.3
      });

      const text = response.choices[0].message.content || "{}";
      const parsed = JSON.parse(text);
      return {
        explanation: parsed.explanation || "Unable to generate explanation.",
        impact: parsed.impact || "Unable to determine impact.",
        fix_code: parsed.fix_code || "// No fix code generated."
      };
    } catch (err) {
      logger.error("AI explain failed:", err);
      return {
        explanation: `${issue.message} — This accessibility issue affects users relying on assistive technologies.`,
        impact: "Users with disabilities, particularly those using screen readers or keyboard navigation, may be impacted.",
        fix_code: "// Please refer to WCAG documentation for fix guidance."
      };
    }
  }

  async generateTestCases(issue: any): Promise<any[]> {
    const prompt = `Generate 3-5 specific accessibility test cases for this issue:
Rule: ${issue.rule_id}, WCAG: ${(issue.wcag_criteria || []).join(", ")}, Message: ${issue.message}

Respond in JSON: { "test_cases": [{ "name": "", "description": "", "steps": [], "expected_result": "" }] }`;

    try {
      const openai = this.azureOpenai();
      if (!openai) {
        return [];
      }

      const response = await openai.chat.completions.create({
        model: this.deploymentName(),
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 800,
        temperature: 0.3
      });
      const parsed = JSON.parse(response.choices[0].message.content || "{}");
      return parsed.test_cases || [];
    } catch {
      return [];
    }
  }
}

export const aiService = new AiService();
