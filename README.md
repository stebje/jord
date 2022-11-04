# Jord

> 🌱 A GitHub Action that helps move workloads into greener time periods

## Description

This action uses the [Carbon Aware SDK/API](https://github.com/Green-Software-Foundation/carbon-aware-sdk) to calculate if a job should be delayed in order to reduce the carbon footprint. 

It does so by:
1. Collecting the current emission rating at the datacenter where the job is running
2. Comparing the current emission rating with the *forecasted* emission rating for that same datacenter
3. If the forecasted emission rating is lower than the current one, then a *job delay* will be calculated
4. If that delay is within the user-defined *delay tolerance* then the job can be paused accordingly

:bulb: Due to limitaitons in the GitHub Actions API, two workflows are needed in order to pause the job, please see below for details.

## Usage

### Main workflow

The workflow below invokes this action. If used in combination with the retriggering workflow (see below), the workflow run is automatically re-triggered, and delayed for X number of minutes.

```yml
name: Test Jord

on:
  workflow_dispatch:

jobs:
  job1:
    name: Job to delay (if needed)
    runs-on: ubuntu-latest
    environment: 
      name: green-delay
    steps:  
      - name: Job to delay (if needed)
        continue-on-error: false
        uses: stebje/jord@v0.1.0
        with:
          token: ${{ secrets.GREENTOKEN }}
          delay-tolerance: 100
          base-url-carbon-aware-api: 'https://carbon-aware-api.azurewebsites.net'
          environment-name: 'green-delay'
      - run: echo 'This step, and subsequent ones, will not run if the job is delayed'
```

### Retriggering workflow

Since a workflow cannot retrigger itself from within an action, a separate, simple, workflow is needed for that. The workflow below used in combination with the one above, will ensure that the job is paused according to the calculated job delay.

The workflow is configured to avoid infinite loops using an `if` condition.

```yml
name: Rerun delayed workflow

on:
  workflow_run:
    workflows: [Test Jord]
    types: [completed]

jobs:
  re-run-job:
    name: Rerun a delayed workflow
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.run_attempt == 1 }}
    steps:
      - uses: actions/github-script@v6
        id: rerun-wf
        with:
          github-token: ${{ secrets.GREENTOKEN }}
          script: |
            console.log(context)

            github.rest.actions.reRunWorkflow({
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: context.payload.workflow_run.id
            })
```

### Action Inputs

| Name              | Description   | Default   | Required |
| :---------------- | :------- | :-----| :------- |
| `token`          | [GitHub Personal Access Token](https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token) (PAT) with `write:repo` and `write:workflow` scope |      | `true`   |
| `delay-tolerance` | The max number of minutes the job can be delayed    | `5`    | `false`  |
| `base-url-carbon-aware-api`    | The base URL of the host where the [Carbon aware WebAPI](https://github.com/Green-Software-Foundation/carbon-aware-sdk) is deployed   | `https://carbon-aware-api.azurewebsites.net`  | `false`  |
| `environment-name` | Desired name of the [repository environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) that will be created and used to delay the job  | `green-delay` | `false`  |

## Contributing

:point_right: [How to contribute](./CONTRIBUTING.md)
:point_right: [Code of Conduct](./CODE_OF_CONDUCT.md)