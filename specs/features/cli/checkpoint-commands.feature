@cli @product/checkpoint
Feature: CLI Checkpoint Commands

  CLI commands for session checkpoint management.

  Background:
    Given the CLI is initialized
    And a space "projects/test" exists

  Rule: checkpoint set command

    Scenario: checkpoint set creates checkpoint
      When running "./mind checkpoint set projects/test \"Implement login\" \"Add OAuth provider\""
      Then a checkpoint exists with the goal
      And it has pending items

    Scenario: checkpoint set with --notes
      When running "./mind checkpoint set projects/test \"Goal\" \"Pending\" --notes \"Some notes\""
      Then the checkpoint includes the notes

    Scenario: checkpoint set updates existing active
      Given an active checkpoint exists
      When running "./mind checkpoint set projects/test \"New goal\" \"New pending\""
      Then the checkpoint is updated

  Rule: checkpoint complete command

    Scenario: checkpoint complete transforms checkpoint into same-space session memory
      Given an active checkpoint in "projects/test" with goal "Implement login" and pending "Add OAuth"
      When running "./mind checkpoint complete projects/test my-checkpoint \"Added OAuth\""
      Then a session memory is created in "projects/test"
      And the checkpoint is deleted from "projects/test"

    Scenario: checkpoint done is alias for complete
      Given an active checkpoint in "projects/test" with goal "Fix bug" and pending "Write tests"
      When running "./mind checkpoint done projects/test my-checkpoint \"Summary\""
      Then a session memory is created in "projects/test"
      And the checkpoint is deleted from "projects/test"

  Rule: checkpoint recover command

    Scenario: checkpoint recover requires --name flag
      Given an active checkpoint with goal "Login feature"
      When running "./mind checkpoint recover projects/test"
      Then an error is shown about checkpoint name being required
      And it suggests using "checkpoint list" first

    Scenario: checkpoint recover outputs checkpoint as JSON
      Given an active checkpoint with goal "Login feature" and pending "Add OAuth"
      When running "./mind checkpoint recover projects/test --name"
      Then the checkpoint is displayed as JSON
      And it includes the goal and pending items

  Rule: checkpoint list command

    Scenario: checkpoint list shows active checkpoints
      Given an active checkpoint exists
      When running "./mind checkpoint list projects/test"
      Then the active checkpoint is listed

    Scenario: checkpoint list --status active
      When running "./mind checkpoint list projects/test --status active"
      Then only active checkpoints are shown

    Scenario: checkpoint list --status completed
      When running "./mind checkpoint list projects/test --status completed"
      Then no checkpoints are shown (completed checkpoints are deleted, not tagged)

  Rule: cp alias

    Scenario: cp set works as alias
      When running "./mind cp set projects/test \"Goal\" \"Pending\""
      Then the checkpoint is created

    Scenario: cp done works as alias
      Given an active checkpoint in "projects/test" with goal "Alias test" and pending "Verify"
      When running "./mind cp done projects/test my-checkpoint \"Summary\""
      Then a session memory is created in "projects/test"
      And the checkpoint is deleted from "projects/test"
