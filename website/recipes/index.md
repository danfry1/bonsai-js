# Recipes

Each recipe builds one job Bonsai is used for, end to end, with code that runs as written. They link to the [API reference](/api/environment) for details.

| Recipe | Builds |
|---|---|
| [Feature Flag Targeting](./feature-flags) | Flag rules written outside engineering: save-time checks, compiled flags evaluated per request within a budget, percentage rollouts, time windows in the user's time zone, and errors sorted by who has to act |
| [User-Defined Filters in SQL](./user-filters-sql) | Filters that end users type, checked against the table's fields and translated to a parameterized SQLite or Postgres `WHERE` clause or a MongoDB filter, with helpful messages for parts that do not translate |
| [Eligibility Rules with Reasons](./eligibility-rules) | Admin-defined eligibility rules with a shared library, a "why you do not qualify" list, an answer to "can this customer ever qualify?", and an audit record of each decision |
