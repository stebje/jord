// Import the necessary dependencies
const core = require('@actions/core')
const { exec } = require('child_process')
const github = require('@actions/github')

async function run() {
  // TODO - Determine OS of runner
  // const RUNNER_OS = await _getRunnerOS() { ... }
  const RUNNER_OS = 'linux' // set to constant for now
  
  // Determine the public IP address of the runner machine
  const PUBLIC_IP = await _getPublicIP(RUNNER_OS)

  // Get physical location of runner machine
  // const RUNNER_LOCATION = await _getRunnerLocation(PUBLIC_IP) { ... }

  // Get current emission level at runner location
  // const CURRENT_EMISSION_LEVEL = await _getEmissionLevel(RUNNER_LOCATION) { ... }

  // Determine whether to run the job or not
  // ...

  // If job is run, create job summary
  // ...
}

run()

async function _getPublicIP(os) {
  // TODO: account for the different actions runners: macos, linux, windows
  // Currently support only linux
  const cmd = await _getPublicIPCmd(os)

  // Execute applicable command for getting public IP of runner
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.log(`error: ${error.message}`)
      core.warning('Something went wrong when determining the public IP address, the workflow will continue.')
      return
    }

    if (stderr) {
      console.log(`stderr: ${stderr}`)
      core.warning('Something went wrong when determining the public IP address, the workflow will continue.')
      return
    }

    const publicIP = stdout
    console.log(publicIP)
    return publicIP
  })
}

async function _getPublicIPCmd(os) {
  let cmd
  
  switch (os) {
    case 'linux':
      cmd = 'dig +short myip.opendns.com @resolver1.opendns.com'
      break
  }

  return cmd
}
