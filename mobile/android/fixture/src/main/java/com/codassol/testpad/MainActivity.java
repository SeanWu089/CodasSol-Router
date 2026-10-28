package com.codassol.testpad;
import android.app.Activity;
import android.os.Bundle;
import android.widget.*;
import android.graphics.Color;
import android.view.MotionEvent;
public class MainActivity extends Activity {
    int count=0,swipes=0;float startX;TextView status;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(1);layout.setPadding(36,100,36,36);layout.setBackgroundColor(Color.rgb(240,245,250));
        TextView title=new TextView(this);title.setText("Codas Test Pad");title.setTextSize(30);layout.addView(title);
        status=new TextView(this);status.setTextSize(24);status.setPadding(0,40,0,40);layout.addView(status);
        Button button=new Button(this);button.setText("TAP +1");button.setOnClickListener(v->{count++;render();});layout.addView(button,new LinearLayout.LayoutParams(-1,160));
        TextView area=new TextView(this);area.setText("Swipe horizontally here");area.setTextSize(22);area.setBackgroundColor(Color.rgb(200,225,240));area.setPadding(24,80,24,80);
        area.setOnTouchListener((v,event)->{if(event.getAction()==MotionEvent.ACTION_DOWN){startX=event.getX();return true;}if(event.getAction()==MotionEvent.ACTION_UP){if(Math.abs(event.getX()-startX)>80){swipes++;render();}v.performClick();return true;}return true;});
        layout.addView(area,new LinearLayout.LayoutParams(-1,400));render();setContentView(layout);
    }
    void render(){status.setText("Taps: "+count+"   Swipes: "+swipes);}
}
