@product_single_space @product_tiering @product_recovery @product_automation
Feature: Single-space session continuity

  Scenario: checkpoints close into same-space session summaries
    Given a project continuity space "projects/mind"
    And an active checkpoint exists in that project space
    When the checkpoint is completed
    Then a same-space memory named "session-*" is created in "projects/mind"
    And the summary memory has tags ["type:session", "cat:summary"]

  Scenario: session summaries default to T3
    Given a completed checkpoint in "projects/mind"
    When the session summary is created
    Then the summary memory is stored at tier 3

  Scenario: recovery prefers same-space continuity artifacts
    Given active checkpoints and session summaries live in "projects/mind"
    When continuity is recovered for the project
    Then same-space session summaries are consulted before legacy compatibility paths

  Scenario: OpenCode prudent automation writes same-space summaries
    Given OpenCode prudent automation persists a session-end summary
    When the summary is written
    Then it is stored in "projects/mind"
    And no new write is made to any legacy session-summary space
