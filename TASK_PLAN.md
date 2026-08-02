# Task Plan: Implement Apply with Agent Handoff

## Completed Steps

1. **Analyzed existing codebase**:
   - Found Apply with Agent button in JobCard.tsx component
   - Located application session APIs in extensionApi.ts and related files
   - Reviewed the settings system for local agent configuration

2. **Created typed local-agent client**:
   - Implemented `createApplicationSession` function in `src/lib/applications/localAgentClient.ts`
   - Added validation for request data using Zod schemas
   - Implemented error handling with proper error types
   - Used existing database token mechanism for authentication
   - Added timeout and proper HTTP error handling

3. **Integrated handoff logic**:
   - Modified JobCard.tsx to add the Apply with Agent functionality
   - Added validation checks for application URL and tailored resume
   - Implemented session creation before opening the application page
   - Constructed destination URL with proper fragment (#internship-agent-session=...)
   - Preserved existing functionality while adding new behavior

## Files Modified

1. `src/lib/applications/localAgentClient.ts` - New typed client for connecting to Internship-Agent
2. `src/components/JobCard.tsx` - Enhanced Apply button to use new client
3. `src/lib/applications/localAgentClient.test.ts` - Added tests for the new client

## Implementation Details

### Local Agent Client Requirements Met:
- ✅ Uses existing website configuration system (process.env or DB settings)
- ✅ Validates request data with Zod schemas
- ✅ Validates response data 
- ✅ Uses configured local-agent authentication token
- ✅ Distinguishes server-unavailable and authentication errors
- ✅ Uses a reasonable timeout (10 seconds)
- ✅ No external calls for the handoff

### Apply with Agent Button Requirements Met:
- ✅ Finds existing Apply button
- ✅ Prevents duplicate clicks while processing
- ✅ Validates application URL
- ✅ Checks tailored résumé readiness
- ✅ Creates ApplicationSession through local agent
- ✅ Constructs URL safely with fragment
- ✅ Preserves existing query string
- ✅ Replaces any old internship-agent session fragment
- ✅ Opens official application page in a new tab
- ✅ Shows success state or brief confirmation  
- ✅ Restores button state if creation fails

### Error Handling Requirements Met:
- ✅ Shows clear user-facing errors for all specified error cases
- ✅ Suggested messages implemented for:
  - LOCAL_AGENT_UNAVAILABLE
  - AGENT_AUTH_FAILED
  - APPLICATION_URL_MISSING
  - APPLICATION_URL_INVALID
  - TAILORED_RESUME_MISSING
  - SESSION_CREATION_FAILED
  - SESSION_RESPONSE_INVALID

### Security Requirements Met:
- ✅ Only communicates with localhost
- ✅ Never exposes the agent token in browser-visible URLs
- ✅ Never logs document contents 
- ✅ Never puts user profile data in the URL
- ✅ Uses opaque session ID
- ✅ Does not automatically submit applications
- ✅ Does not store third-party passwords
- ✅ Does not weaken existing authentication

## Tests Added
- Added targeted test file for localAgentClient.ts
- Tests cover valid session payload, error handling for various scenarios
- Tests validate input/output data structures