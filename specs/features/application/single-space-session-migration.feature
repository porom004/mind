@application_migration @application_link_preservation @application_idempotency
Feature: Legacy session summary migration

  Scenario: explicit migration reports same-space targets in dry-run mode
    Given legacy summaries exist in "sessions/mind"
    When I run the migration for "projects/mind" with dry-run enabled
    Then the report lists deterministic same-space target names in "projects/mind"
    And no data is mutated

  Scenario: migration preserves links and provenance
    Given a legacy summary in "sessions/mind" has inbound and outbound links
    When I migrate it into "projects/mind"
    Then the migrated summary keeps those links
    And the migrated content records provenance for the legacy space and name

  Scenario: rerunning migration is idempotent
    Given legacy session summaries were already migrated into "projects/mind"
    When I run the migration again
    Then no duplicate session summaries are created
