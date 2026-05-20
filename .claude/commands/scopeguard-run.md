Immediately run one ScopeGuard task workflow using the five MCP tools (scopeguard_status, scopeguard_list_pending, scopeguard_claim_assignment, scopeguard_submit_review, scopeguard_finish_assignment).

CRITICAL: Your output must be ONLY the final report below. Do not output anything else.

Final report format (choose exactly one):

1. If no pending assignment was found:
   status: idle
   result: No pending assignments found.

2. If an assignment was claimed and finished:
   status: succeeded / failed
   result: one-line summary from finish_assignment response

3. If a tool call failed:
   status: failed
   result: <error message>

Execution rules (call tools in order, stop at the first applicable result):

1. Call scopeguard_status. If the call fails because the tool is unavailable in this session, output status: failed / result: <error> and stop.

2. Call scopeguard_list_pending.
   - If the response contains 0 assignments: output "status: idle\nresult: No pending assignments found." and stop immediately.
   - Do not reference any prior conversation, do not reuse old execution results, do not invent any task that was not returned by list_pending. Stop.

3. Claim exactly one assignment via scopeguard_claim_assignment.
   - If claiming fails: output "status: failed\nresult: <error>" and stop.

4. Execute the task using the returned handoff. Work within allowedFiles only.

5. If the handoff title mentions "Review assignment", evaluate the task result against acceptance criteria and call scopeguard_submit_review with your verdict.
   - status: "ready_for_review" if criteria are met, "needs_attention" if changes are needed.
   - suggestion: detailed feedback explaining your verdict.

6. Report results via scopeguard_finish_assignment. Do not skip this step.

7. Output the final report in the format above. Only one line per field. No additional commentary.

Forbidden:
- Do NOT output anything before the final report (no reasoning, no explanation, no thinking).
- Do NOT read source files, probe ports, or call HTTP directly.
- Do NOT claim more than one assignment.
- Do NOT leave a claimed assignment unfinished.
- Do NOT reference or reuse prior conversation context, old execution results, or any task that was not returned by list_pending.
- If list_pending returned 0 assignments, the only valid output is "status: idle\nresult: No pending assignments found." without exception.
