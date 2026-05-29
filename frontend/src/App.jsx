import './App.css'
import alytechLogo from './assets/alytech-logo.svg'

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <img className="app-logo" src={alytechLogo} alt="ALYTECH Solucoes e Servicos" />
      </header>

      <main className="dashboard-shell">
        <iframe
          className="dashboard-frame"
          src="http://18.191.242.141:3001/d/dse855-scada/dse-855-scada?orgId=1&from=now-5m&to=now&timezone=browser&refresh=5s&kiosk"
          title="Grafana Dashboard"
        />
      </main>
    </div>
  );
}

export default App
