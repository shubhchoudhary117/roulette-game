import { Component } from '@angular/core';

import { RouletteComponent } from './roulette/roulette.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ RouletteComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  title = 'roulette-game';
}
