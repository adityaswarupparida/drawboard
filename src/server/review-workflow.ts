import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { REVIEW_STEPS, type Finding } from "../shared/protocol";
import { reviewArea } from "./ai";
import type { CanvasAgent } from "./canvas-agent";
import type { Env } from "./env";

type Params = { requestedBy: string };

// One step per area so a failed model call retries only that area.
export class DesignReviewWorkflow extends AgentWorkflow<CanvasAgent, Params, unknown, Env> {
  async run(event: AgentWorkflowEvent<Params>, step: AgentWorkflowStep) {
    const diagram = await step.do("load diagram", async () => this.agent.getDiagram());

    const findings: Finding[] = [];
    for (const [i, area] of REVIEW_STEPS.entries()) {
      await step.do(`mark ${area}`, async () => {
        await this.agent.setReviewStep(i);
      });
      const found = await step.do(
        `review ${area}`,
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        async () => reviewArea(this.env.AI, diagram, area),
      );
      findings.push(...found);
    }

    await step.do("publish findings", async () => {
      await this.agent.publishReview(findings, event.payload.requestedBy);
    });
    return { findings: findings.length };
  }
}
