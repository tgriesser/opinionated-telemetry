- Guarding Attribute Assignment
  - Allow/Deny for attribute assignment
  - Determine where this should go in the lifecycle

- setParentAttribute
  - tcp.connect.duration
  - dns.lookup.duration

- Auto Metrics?
  - Redis
  - MySQL
  - Postgres

- dropSpan API
  - on span start - easy, allows for simple re-parenting?
  - on span end - reparenting simple if tail-based trace enabled?
  - attach to parent & complete/send on parent span completion if we know we have a dropSpan on-end?

- Metrics Considerations
  - Views for HTTP req's

- onSampledSpan hook
  - Ideas for capturing & archiving?

- Explicit Span Transmission Failure handling

- Suppress Tracing API
